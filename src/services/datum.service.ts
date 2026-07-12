import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getAddressInfo } from 'bitcoin-address-validation';
import * as bitcoinjs from 'bitcoinjs-lib';
import { firstValueFrom } from 'rxjs';
import { Server, Socket } from 'net';

import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ClientService } from '../ORM/client/client.service';
import { ShareAccountingService } from '../ORM/share-accounting/share-accounting.service';
import {
    DATUM_INITIAL_HEADER_KEY,
    DatumFrameReader,
    DatumMiningCommand,
    DatumProtocolCommand,
    DatumRejectReason,
    DatumShareResponseStatus,
    DatumPowSubmit,
    DatumJobValidationStatus,
    DatumJobValidationResponse,
    DatumPayoutOutput,
    deserializeDatumCoinbaserFetch,
    deserializeDatumJobValidationResponse,
    deserializeDatumMiningCommand,
    deserializeDatumPowSubmit,
    encodeDatumFrame,
    serializeDatumJobValidationFullTransactionBlobRequest,
    serializeDatumJobValidationShortTxIdsRequest,
    serializeDatumCoinbaserFetchResponse,
    serializeDatumShareResponse,
} from '../models/datum/datum-codec';
import { DatumCryptoSession } from '../models/datum/datum-crypto';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { CustomWorkService } from './custom-work.service';
import { RedisMessagingService } from './redis-messaging.service';
import { IJobTemplate, StratumV1JobsService } from './stratum-v1-jobs.service';
import { DatumKeyPair } from '../models/datum/datum-crypto';
import { TemplateProviderService } from './template-provider.service';
import { StratumV1ClientStatistics } from '../models/StratumV1ClientStatistics';
import type { AddressObject } from '../models/MiningJob';
import { PayoutSnapshotService } from '../ORM/payout-snapshot/payout-snapshot.service';
import { parsePayoutModePorts, PayoutMode } from '../types/payout-mode';

const DEFAULT_DATUM_SHARE_DIFFICULTY = 1;
const DEFAULT_DATUM_PING_INTERVAL_MS = 30_000;
const DEFAULT_CLIENT_HASHRATE_PERSIST_INTERVAL_MS = 60_000;

@Injectable()
export class DatumService implements OnModuleInit {
    private readonly servers: Server[] = [];
    private identityKeys: DatumKeyPair | null = null;

    constructor(
        private readonly configService: ConfigService,
        private readonly jobsService: StratumV1JobsService,
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly clientService: ClientService,
        private readonly blocksService: BlocksService,
        private readonly shareAccountingService: ShareAccountingService,
        private readonly customWorkService: CustomWorkService,
        private readonly templateProvider: TemplateProviderService,
        private readonly redisMessagingService?: RedisMessagingService,
        private readonly payoutSnapshotService?: PayoutSnapshotService,
    ) {}

    public async onModuleInit(): Promise<void> {
        if (process.env.API_ONLY === 'true' || process.env.MASTER === 'true') {
            return;
        }

        const ports = this.getPorts();
        if (ports.length === 0) {
            return;
        }

        this.identityKeys = this.getIdentityKeys();
        console.log(`DATUM server public key: ${Buffer.concat([this.identityKeys.edPublicKey, this.identityKeys.xPublicKey]).toString('hex')}`);

        for (const { port, payoutMode } of ports) {
            await this.startServer(port, payoutMode);
        }
    }

    private async startServer(port: number, payoutMode: PayoutMode): Promise<void> {
        const server = new Server(socket => {
            void this.handleSocket(socket, payoutMode);
        });
        server.on('error', error => {
            console.error(`DATUM server error on port ${port}: ${error.message}`);
        });
        server.listen(port, () => {
            console.log(`DATUM ${payoutMode} server is listening on port ${port}`);
        });
        this.servers.push(server);
    }

    private async handleSocket(socket: Socket, payoutMode: PayoutMode): Promise<void> {
        socket.setKeepAlive(true, 60_000);
        socket.setNoDelay(true);

        const session = await DatumCryptoSession.create(this.identityKeys ?? undefined);
        const reader = new DatumFrameReader(DATUM_INITIAL_HEADER_KEY);
        const state: DatumClientState = {
            sessionId: Math.random().toString(16).slice(2, 10),
            payoutMode,
            session,
            clientEntity: null,
            address: null,
            workerName: 'default',
            userAgent: 'datum/unknown',
            pingTimer: null,
            datumJobs: new Map(),
            coinbaserPayoutContexts: new Map(),
            nextCoinbaserId: 1,
            statistics: new StratumV1ClientStatistics(this.getConfiguredDatumShareDifficulty()),
            lastHashRatePersistedAt: 0,
        };
        this.logVerbose(`[DATUM ${state.sessionId}] connection accepted from ${socket.remoteAddress}:${socket.remotePort}`);

        const close = () => {
            void this.destroyClient(state);
            if (!socket.destroyed) {
                socket.destroy();
            }
        };

        socket.on('data', data => {
            void (async () => {
                try {
                    reader.setHeaderXorKey(session.currentReceiveHeaderKey);
                    const frames = reader.feed(data);
                    for (const frame of frames) {
                        let payload = frame.payload;
                        if (frame.header.isEncryptedChannel) {
                            payload = session.decryptChannelPayload(payload);
                        }
                        await this.handleFrame(socket, state, frame.header.protoCmd, payload);
                        reader.setHeaderXorKey(session.currentReceiveHeaderKey);
                    }
                } catch (error) {
                    console.error(`[DATUM ${state.sessionId}] ${error.message}`);
                    close();
                }
            })();
        });
        socket.on('error', close);
        socket.on('close', () => void this.destroyClient(state));
    }

    private async handleFrame(socket: Socket, state: DatumClientState, protoCmd: number, payload: Buffer): Promise<void> {
        if (protoCmd === DatumProtocolCommand.HANDSHAKE_INIT) {
            const hello = state.session.openHandshake(payload);
            state.userAgent = hello.userAgent || 'datum/unknown';
            this.logVerbose(`[DATUM ${state.sessionId}] handshake init from ${state.userAgent}`);
            await this.writeRaw(socket, state.session.buildHandshakeResponse(hello, 'public-pool DATUM'));
            this.logVerbose(`[DATUM ${state.sessionId}] handshake response sent`);
            await this.sendDatumClientConfigure(socket, state);
            this.logVerbose(`[DATUM ${state.sessionId}] client configure sent`);
            this.startDatumPing(socket, state);
            return;
        }

        if (protoCmd !== DatumProtocolCommand.MINING) {
            return;
        }

        const mining = deserializeDatumMiningCommand(payload);
        switch (mining.command) {
            case DatumMiningCommand.FETCH_COINBASER:
                await this.handleCoinbaserFetch(socket, state, mining.body);
                break;
            case DatumMiningCommand.SUBMIT_POW:
                await this.handlePowSubmit(socket, state, mining.body);
                break;
            case DatumMiningCommand.JOB_VALIDATION:
                await this.handleJobValidationResponse(socket, state, mining.body);
                break;
            case DatumMiningCommand.TEMPLATE_REFRESH:
                break;
            default:
                console.warn(`[DATUM ${state.sessionId}] Ignoring unsupported mining command 0x${mining.command.toString(16)}`);
                break;
        }
    }

    private async sendDatumClientConfigure(socket: Socket, state: DatumClientState): Promise<void> {
        const payoutAddress = this.getDatumPoolPayoutAddress();
        if (!payoutAddress) {
            throw new Error('DATUM_POOL_PAYOUT_ADDRESS or DEV_FEE_ADDRESS must be set before DATUM client configuration can be sent');
        }

        const payoutScript = bitcoinjs.address.toOutputScript(payoutAddress, this.getNetwork());
        if (payoutScript.length > 255) {
            throw new Error(`DATUM payout script is too long: ${payoutScript.length}`);
        }

        const coinbaseTag = Buffer.from('public-pool', 'utf8');
        if (coinbaseTag.length > 255) {
            throw new Error(`DATUM coinbase tag is too long: ${coinbaseTag.length}`);
        }

        const minDifficulty = Math.max(1, Math.floor(this.getConfiguredDatumShareDifficulty()));
        const vardiffMin = 1n << BigInt(Math.ceil(Math.log2(minDifficulty)));
        const vardiffMinBuffer = Buffer.alloc(8);
        vardiffMinBuffer.writeBigUInt64LE(vardiffMin, 0);

        const payload = Buffer.concat([
            Buffer.from([DatumMiningCommand.CLIENT_CONFIGURE]),
            Buffer.from([1, payoutScript.length]),
            payoutScript,
            uint32le(0x50554250),
            Buffer.from([coinbaseTag.length]),
            coinbaseTag,
            vardiffMinBuffer,
            Buffer.from([0, 0xfe]),
        ]);
        await this.writeRaw(socket, state.session.encryptChannelFrame(DatumProtocolCommand.MINING, payload, true));
    }

    private async handleCoinbaserFetch(socket: Socket, state: DatumClientState, payload: Buffer): Promise<void> {
        const fetch = deserializeDatumCoinbaserFetch(payload);
        const latestTemplate = await firstValueFrom(this.jobsService.newMiningJob$);
        const payoutOutputs = this.getDatumPayoutOutputs(latestTemplate, Number(fetch.rewardValue), state.payoutMode);
        if (payoutOutputs.length === 0) {
            throw new Error('DATUM_POOL_PAYOUT_ADDRESS or DEV_FEE_ADDRESS must be set before DATUM coinbaser fetches can be served');
        }

        const coinbaserId = this.nextDatumCoinbaserId(state);
        state.coinbaserPayoutContexts.set(coinbaserId, {
            payoutOutputs,
            payoutSnapshotId: latestTemplate.blockData.payoutSnapshotId ?? null,
            blockHeight: latestTemplate.blockData.height,
            payoutMode: state.payoutMode,
        });
        if (state.coinbaserPayoutContexts.size > 512) {
            const oldestCoinbaserId = state.coinbaserPayoutContexts.keys().next().value;
            if (oldestCoinbaserId != null) {
                state.coinbaserPayoutContexts.delete(oldestCoinbaserId);
            }
        }

        const response = serializeDatumCoinbaserFetchResponse(fetch.rewardValue, payoutOutputs, coinbaserId);
        await this.writeRaw(socket, state.session.encryptChannelFrame(DatumProtocolCommand.MINING, response));
    }

    private async handlePowSubmit(socket: Socket, state: DatumClientState, payload: Buffer): Promise<void> {
        const pow = deserializeDatumPowSubmit(payload);
        const { address, workerName } = this.parseUserIdentity(pow.username);
        if (!this.isValidAddress(address)) {
            await this.sendShareResponse(socket, state, DatumShareResponseStatus.REJECTED, DatumRejectReason.BAD_USERNAME, pow.nonce, pow.targetByte, pow.jobId);
            return;
        }

        state.address = address;
        state.workerName = workerName;
        await this.ensureClientEntity(state);

        const datumJob = this.updateDatumJobCache(state, pow);
        await this.maybeRequestDatumJobValidation(socket, state, pow.jobId, datumJob);
        const coinbase = this.getDatumCoinbase(datumJob, pow);
        if (coinbase == null || datumJob.prevBlockHash == null || datumJob.nBits == null || datumJob.merkleBranches == null) {
            await this.sendShareResponse(socket, state, DatumShareResponseStatus.REJECTED, DatumRejectReason.COINBASE_MISSING, pow.nonce, pow.targetByte, pow.jobId);
            return;
        }
        if (datumJob.targetByteIndex == null) {
            await this.sendShareResponse(socket, state, DatumShareResponseStatus.REJECTED, DatumRejectReason.BAD_TARGET, pow.nonce, pow.targetByte, pow.jobId);
            return;
        }

        const latestTemplate = await firstValueFrom(this.jobsService.newMiningJob$);
        const templateValidation = this.templateProvider.validateDatumTemplateFastPath({
            prevBlockHash: datumJob.prevBlockHash,
            nBits: datumJob.nBits,
            height: datumJob.height,
            version: pow.version,
            coinbaseValue: datumJob.coinbaseValue,
            totalWeight: datumJob.totalWeight,
            totalSize: datumJob.totalSize,
            totalSigops: datumJob.totalSigops,
            merkleBranches: datumJob.merkleBranches,
        });
        if (!templateValidation.valid) {
            await this.sendShareResponse(
                socket,
                state,
                DatumShareResponseStatus.REJECTED,
                this.mapDatumTemplateRejectReason(templateValidation.errorCode),
                pow.nonce,
                pow.targetByte,
                pow.jobId,
            );
            return;
        }
        if (datumJob.validationState === 'failed') {
            await this.sendShareResponse(socket, state, DatumShareResponseStatus.REJECTED, DatumRejectReason.OTHER, pow.nonce, pow.targetByte, pow.jobId);
            return;
        }
        const payoutValidation = this.validateDatumCoinbasePayoutContext(coinbase, pow, latestTemplate, datumJob, state);
        if (!payoutValidation.validation.valid) {
            this.logDatumCoinbaseMismatchOnce(state, payoutValidation.validation);
            await this.sendShareResponse(socket, state, DatumShareResponseStatus.REJECTED, DatumRejectReason.BAD_COINBASER_ID, pow.nonce, pow.targetByte, pow.jobId);
            return;
        }
        if (payoutValidation.context != null) {
            datumJob.expectedPayoutOutputs = payoutValidation.context.payoutOutputs;
            datumJob.payoutSnapshotId = payoutValidation.context.payoutSnapshotId;
        }

        const shareDifficulty = this.getDatumSubmittedShareDifficulty(pow);
        const nBits = datumJob.nBits.readUInt32LE(0);
        const validation = this.customWorkService.validateShare({
            coinbasePrefix: coinbase.coinb1,
            coinbaseSuffix: coinbase.coinb2,
            coinbaseTargetByteIndex: datumJob.targetByteIndex,
            coinbaseTargetByte: pow.targetByte,
            merklePath: datumJob.merkleBranches,
            extranoncePrefix: Buffer.alloc(0),
            extranonce: pow.extranonce,
            prevHash: datumJob.prevBlockHash,
            nBits,
            version: pow.version,
            ntime: pow.ntime,
            nonce: pow.nonce,
            shareDifficulty,
            networkDifficulty: latestTemplate.blockData.networkDifficulty,
        });

        if (!validation.accepted) {
            await this.sendShareResponse(socket, state, DatumShareResponseStatus.REJECTED, DatumRejectReason.HIGH_HASH, pow.nonce, pow.targetByte, pow.jobId);
            return;
        }

        const isBlockCandidate = validation.isBlockCandidate || pow.isBlock;
        const blockSubmissionResult = validation.isBlockCandidate ? 'datum-gateway-submit-expected' : null;

        await this.sendShareResponse(socket, state, DatumShareResponseStatus.ACCEPTED, 0, pow.nonce, pow.targetByte, pow.jobId);
        if (isBlockCandidate) {
            await this.blocksService.save({
                height: datumJob.height ?? latestTemplate.blockData.height,
                minerAddress: address,
                worker: workerName,
                sessionId: state.sessionId,
                blockData: validation.header.toString('hex'),
                blockSubmissionResult,
                payoutSnapshotId: state.payoutMode === 'pplns'
                    ? datumJob.payoutSnapshotId ?? null
                    : null,
                payoutMode: state.payoutMode,
            });
            if (state.payoutMode === 'pplns') {
                await this.payoutSnapshotService?.finalizeSnapshotForBlock({
                    payoutSnapshotId: datumJob.payoutSnapshotId,
                    blockHeight: datumJob.height ?? latestTemplate.blockData.height,
                    blockSubmissionResult,
                    payoutMode: state.payoutMode,
                });
            }
        }
        await this.shareAccountingService.recordAcceptedShare({
            protocol: 'datum',
            payoutMode: state.payoutMode,
            workSource: 'miner_template',
            workProtocol: 'datum',
            address,
            clientName: workerName,
            sessionId: state.sessionId,
            clientId: state.clientEntity.id,
            jobId: pow.jobId.toString(16),
            jobTemplateId: latestTemplate.blockData.id,
            blockHeight: datumJob.height ?? latestTemplate.blockData.height,
            creditedDifficulty: shareDifficulty,
            submissionDifficulty: validation.submissionDifficulty,
            networkDifficulty: latestTemplate.blockData.networkDifficulty,
            nonce: pow.nonce,
            ntime: pow.ntime,
            version: pow.version,
            extraNonce2: pow.extranonce.toString('hex'),
            isBlockCandidate,
            blockSubmissionResult,
        });
        await this.updateAcceptedSharePresence(state, address, workerName, validation.submissionDifficulty, shareDifficulty);
    }

    private async updateAcceptedSharePresence(
        state: DatumClientState,
        address: string,
        workerName: string,
        submissionDifficulty: number,
        creditedDifficulty: number,
    ): Promise<void> {
        if (state.clientEntity == null) {
            return;
        }

        await state.statistics.addShares(state.clientEntity, creditedDifficulty);
        state.clientEntity.hashRate = state.statistics.hashRate;
        await this.persistClientHashRate(state, new Date());
        if (submissionDifficulty > Number(state.clientEntity.bestDifficulty ?? 0)) {
            await this.clientService.updateBestDifficultyIfHigher(state.clientEntity.id, submissionDifficulty);
            state.clientEntity.bestDifficulty = submissionDifficulty;
        }
    }

    private updateDatumJobCache(state: DatumClientState, pow: DatumPowSubmit): DatumJobCache {
        let cache = state.datumJobs.get(pow.jobId);
        if (cache == null || pow.prevBlockHash != null) {
            cache = {
                coinbasePairs: new Map(),
            };
            state.datumJobs.set(pow.jobId, cache);
        }

        if (pow.prevBlockHash != null) {
            cache.prevBlockHash = pow.prevBlockHash;
        }
        if (pow.targetByteIndex != null) {
            cache.targetByteIndex = pow.targetByteIndex;
        }
        if (pow.nBits != null) {
            cache.nBits = pow.nBits;
        }
        if (pow.coinbaserId != null) {
            cache.coinbaserId = pow.coinbaserId;
            const payoutContext = state.coinbaserPayoutContexts.get(pow.coinbaserId);
            if (payoutContext != null) {
                cache.expectedPayoutOutputs = payoutContext.payoutOutputs;
                cache.payoutSnapshotId = payoutContext.payoutSnapshotId;
            }
        }
        if (pow.height != null) {
            cache.height = pow.height;
        }
        if (pow.coinbaseValue != null) {
            cache.coinbaseValue = pow.coinbaseValue;
        }
        if (pow.transactionCount != null) {
            cache.transactionCount = pow.transactionCount;
        }
        if (pow.totalWeight != null) {
            cache.totalWeight = pow.totalWeight;
        }
        if (pow.totalSize != null) {
            cache.totalSize = pow.totalSize;
        }
        if (pow.totalSigops != null) {
            cache.totalSigops = pow.totalSigops;
        }
        if (pow.merkleBranches != null) {
            cache.merkleBranches = pow.merkleBranches;
        }
        for (const [coinbaseId, coinbase] of pow.coinbasePairs) {
            cache.coinbasePairs.set(coinbaseId, coinbase);
        }
        if (pow.subsidyOnlyCoinbase != null) {
            cache.subsidyOnlyCoinbase = pow.subsidyOnlyCoinbase;
        }

        return cache;
    }

    private async maybeRequestDatumJobValidation(
        socket: Socket,
        state: DatumClientState,
        jobId: number,
        cache: DatumJobCache,
    ): Promise<void> {
        if (cache.transactionCount == null || cache.validationState != null) {
            return;
        }
        if (cache.transactionCount === 0) {
            cache.validationState = 'validated';
            cache.validationTransactions = [];
            return;
        }

        cache.validationState = 'requested-short-txids';
        cache.validationRequestedAt = new Date();
        await this.writeRaw(
            socket,
            state.session.encryptChannelFrame(
                DatumProtocolCommand.MINING,
                serializeDatumJobValidationShortTxIdsRequest(jobId),
            ),
        );
    }

    private async handleJobValidationResponse(socket: Socket, state: DatumClientState, payload: Buffer): Promise<void> {
        const response = deserializeDatumJobValidationResponse(payload);
        const cache = state.datumJobs.get(response.jobId);
        if (cache == null) {
            console.warn(`[DATUM ${state.sessionId}] Ignoring validation response for unknown job ${response.jobId}`);
            return;
        }

        if (response.status !== DatumJobValidationStatus.SUCCESS) {
            cache.validationState = 'failed';
            cache.validationError = `gateway returned status 0x${response.status.toString(16)}`;
            console.warn(`[DATUM ${state.sessionId}] Job ${response.jobId} validation failed: ${cache.validationError}`);
            return;
        }

        if (response.kind === 'short-txids') {
            if (cache.transactionCount != null && response.transactionCount !== cache.transactionCount) {
                cache.validationState = 'failed';
                cache.validationError = `short txid count mismatch: advertised ${cache.transactionCount}, received ${response.transactionCount}`;
                console.warn(`[DATUM ${state.sessionId}] Job ${response.jobId} validation failed: ${cache.validationError}`);
                return;
            }
            cache.validationShortTxIds = response.shortTxIds;
            cache.validationShortTxCrosscheck = response.crosscheck ?? undefined;
            cache.validationState = 'requested-full-transaction-blob';
            await this.writeRaw(
                socket,
                state.session.encryptChannelFrame(
                    DatumProtocolCommand.MINING,
                    serializeDatumJobValidationFullTransactionBlobRequest(response.jobId),
                ),
            );
            return;
        }

        if (response.kind === 'full-transaction-blob' || response.kind === 'full-transactions') {
            const validationError = this.validateDatumTransactionResponse(cache, response);
            if (validationError != null) {
                cache.validationState = 'failed';
                cache.validationError = validationError;
                console.warn(`[DATUM ${state.sessionId}] Job ${response.jobId} transaction validation failed: ${validationError}`);
                return;
            }

            cache.validationState = 'validated';
            cache.validationError = undefined;
            cache.validationTransactions = response.transactions;
            cache.validationCompletedAt = new Date();
        }
    }

    private validateDatumTransactionResponse(
        cache: DatumJobCache,
        response: DatumJobValidationResponse,
    ): string | null {
        if (response.kind === 'short-txids') {
            return null;
        }
        if (cache.transactionCount != null && response.transactionCount !== cache.transactionCount) {
            return `transaction count mismatch: advertised ${cache.transactionCount}, received ${response.transactionCount}`;
        }

        const validation = this.templateProvider.validateTransactionData({
            transactionList: response.transactions,
            expectedCount: cache.transactionCount,
            maxTotalBytes: cache.totalSize,
            expectedCoinbaseMerklePath: cache.merkleBranches,
        });
        if (!validation.valid) {
            return validation.errorCode ?? 'invalid-transaction-data';
        }

        return null;
    }

    private getDatumCoinbase(cache: DatumJobCache, pow: DatumPowSubmit): { coinb1: Buffer; coinb2: Buffer } | undefined {
        if (pow.subsidyOnly) {
            return cache.subsidyOnlyCoinbase ?? cache.coinbasePairs.get(pow.coinbaseId);
        }
        return cache.coinbasePairs.get(pow.coinbaseId) ?? cache.subsidyOnlyCoinbase;
    }

    private validateDatumCoinbasePayouts(
        coinbase: { coinb1: Buffer; coinb2: Buffer },
        pow: Pick<DatumPowSubmit, 'extranonce' | 'targetByteIndex' | 'targetByte'>,
        latestTemplate: IJobTemplate,
        coinbaseValue?: bigint,
        expectedPayoutOutputs?: DatumPayoutOutput[],
        payoutMode?: PayoutMode,
    ): DatumCoinbasePayoutValidation {
        const rewardValue = coinbaseValue == null
            ? latestTemplate.blockData.coinbasevalue
            : Number(coinbaseValue);
        const expectedOutputs = expectedPayoutOutputs ?? this.getDatumPayoutOutputs(latestTemplate, rewardValue, payoutMode);
        if (expectedOutputs.length === 0) {
            return { valid: false, expectedOutputs, submittedOutputs: [], error: 'missing-expected-outputs' };
        }

        let coinbaseTx = Buffer.concat([
            coinbase.coinb1,
            pow.extranonce,
            coinbase.coinb2,
        ]);
        coinbaseTx = Buffer.from(coinbaseTx);
        if (pow.targetByteIndex != null) {
            if (pow.targetByteIndex < 0 || pow.targetByteIndex >= coinbaseTx.length) {
                return { valid: false, expectedOutputs, submittedOutputs: [], error: 'target-byte-out-of-range' };
            }
            coinbaseTx[pow.targetByteIndex] = pow.targetByte & 0xff;
        }

        let transaction: bitcoinjs.Transaction;
        try {
            transaction = bitcoinjs.Transaction.fromBuffer(coinbaseTx);
        } catch {
            return { valid: false, expectedOutputs, submittedOutputs: [], error: 'invalid-coinbase-transaction' };
        }

        const submittedOutputs = transaction.outs
            .filter(output => !this.isIgnoredCoinbaseMetadataOutput(output))
            .map(output => ({
                value: BigInt(output.value),
                scriptPubKey: Buffer.from(output.script),
            }));

        if (submittedOutputs.length !== expectedOutputs.length) {
            return { valid: false, expectedOutputs, submittedOutputs, error: 'output-count-mismatch' };
        }

        const valid = expectedOutputs.every((expected, index) => {
            const submitted = submittedOutputs[index];
            return submitted.value === expected.value
                && submitted.scriptPubKey.equals(expected.scriptPubKey);
        });
        return {
            valid,
            expectedOutputs,
            submittedOutputs,
            error: valid ? undefined : 'output-mismatch',
        };
    }

    private validateDatumCoinbasePayoutContext(
        coinbase: { coinb1: Buffer; coinb2: Buffer },
        pow: DatumPowSubmit,
        latestTemplate: IJobTemplate,
        datumJob: DatumJobCache,
        state: DatumClientState,
    ): { validation: DatumCoinbasePayoutValidation; context?: DatumCoinbaserPayoutContext } {
        const primaryValidation = this.validateDatumCoinbasePayouts(
            coinbase,
            pow,
            latestTemplate,
            datumJob.coinbaseValue,
            datumJob.expectedPayoutOutputs,
            state.payoutMode,
        );
        if (primaryValidation.valid) {
            return { validation: primaryValidation };
        }

        for (const context of state.coinbaserPayoutContexts.values()) {
            if (context.payoutMode != null && context.payoutMode !== state.payoutMode) {
                continue;
            }
            if (context.blockHeight != null && datumJob.height != null && context.blockHeight !== datumJob.height) {
                continue;
            }
            if (context.payoutOutputs === datumJob.expectedPayoutOutputs) {
                continue;
            }

            const validation = this.validateDatumCoinbasePayouts(
                coinbase,
                pow,
                latestTemplate,
                datumJob.coinbaseValue,
                context.payoutOutputs,
                state.payoutMode,
            );
            if (validation.valid) {
                return { validation, context };
            }
        }

        return { validation: primaryValidation };
    }

    private getDatumPayoutOutputs(latestTemplate: { blockData?: { payoutOutputs?: AddressObject[] } }, rewardValue: number, payoutMode: PayoutMode = 'solo'): DatumPayoutOutput[] {
        const configuredOutputs = latestTemplate?.blockData?.payoutOutputs;
        const payoutAddresses = payoutMode === 'pplns' && configuredOutputs?.length > 0
            ? configuredOutputs
            : this.getDatumFallbackPayoutOutputs(rewardValue);

        let rewardBalance = Math.max(0, Math.floor(rewardValue));
        const outputs = payoutAddresses.map((recipientAddress, index) => {
            const amount = recipientAddress.amountSats == null
                ? Math.floor(((recipientAddress.percent ?? 0) / 100) * rewardValue)
                : recipientAddress.amountSats;
            rewardBalance -= amount;
            return {
                value: BigInt(amount),
                scriptPubKey: bitcoinjs.address.toOutputScript(recipientAddress.address, this.getNetwork()),
            };
        });
        if (outputs.length > 0 && rewardBalance !== 0) {
            outputs[0] = {
                ...outputs[0],
                value: outputs[0].value + BigInt(rewardBalance),
            };
        }

        return outputs;
    }

    private nextDatumCoinbaserId(state: DatumClientState): number {
        const id = state.nextCoinbaserId;
        state.nextCoinbaserId = state.nextCoinbaserId >= 254 ? 1 : state.nextCoinbaserId + 1;
        return id;
    }

    private getDatumFallbackPayoutOutputs(rewardValue: number): AddressObject[] {
        const payoutAddress = this.getDatumPoolPayoutAddress();
        if (!payoutAddress) {
            return [];
        }
        return [{ address: payoutAddress, amountSats: Math.max(0, Math.floor(rewardValue)) }];
    }

    private isIgnoredCoinbaseMetadataOutput(output: { value: bigint | number; script: Buffer }): boolean {
        if (this.isWitnessCommitmentOutput(output.script)) {
            return true;
        }

        return BigInt(output.value) === 0n
            && output.script.length > 0
            && output.script[0] === bitcoinjs.opcodes.OP_RETURN;
    }

    private isWitnessCommitmentOutput(script: Buffer): boolean {
        return script.length === 38
            && script[0] === bitcoinjs.opcodes.OP_RETURN
            && script[1] === 0x24
            && script.subarray(2, 6).equals(Buffer.from('aa21a9ed', 'hex'));
    }

    private logDatumCoinbaseMismatchOnce(
        state: DatumClientState,
        validation: DatumCoinbasePayoutValidation,
    ): void {
        if (state.coinbaseMismatchLogged) {
            return;
        }
        state.coinbaseMismatchLogged = true;
        console.warn(`[DATUM ${state.sessionId}] Coinbase payout mismatch (${validation.error}); expected=${this.describeDatumOutputs(validation.expectedOutputs)} submitted=${this.describeDatumOutputs(validation.submittedOutputs)}`);
    }

    private describeDatumOutputs(outputs: DatumPayoutOutput[]): string {
        return outputs
            .map(output => {
                const address = this.tryOutputAddress(output.scriptPubKey);
                return `${output.value.toString()}:${address ?? output.scriptPubKey.toString('hex')}`;
            })
            .join(',');
    }

    private tryOutputAddress(scriptPubKey: Buffer): string | null {
        try {
            return bitcoinjs.address.fromOutputScript(scriptPubKey, this.getNetwork());
        } catch {
            return null;
        }
    }

    private async sendShareResponse(
        socket: Socket,
        state: DatumClientState,
        status: DatumShareResponseStatus,
        reasonCode: number,
        nonce: number,
        targetByte: number,
        jobId: number,
    ): Promise<void> {
        const payload = serializeDatumShareResponse({ status, reasonCode, nonce, targetByte, jobId });
        await this.writeRaw(socket, state.session.encryptChannelFrame(DatumProtocolCommand.MINING, payload));
    }

    private async ensureClientEntity(state: DatumClientState): Promise<void> {
        if (state.clientEntity != null) {
            return;
        }
        state.clientEntity = await this.clientService.insert({
            sessionId: state.sessionId,
            address: state.address,
            clientName: state.workerName,
            userAgent: state.userAgent,
            startTime: new Date(),
            payoutMode: state.payoutMode,
            bestDifficulty: 0,
        });
    }

    private async persistClientHashRate(state: DatumClientState, now: Date): Promise<void> {
        if (state.clientEntity?.id == null) {
            return;
        }

        const hashRate = Number(state.statistics?.hashRate ?? 0);
        if (!Number.isFinite(hashRate) || hashRate <= 0) {
            return;
        }

        const intervalMs = this.getHashRatePersistIntervalMs();
        const nowMs = now.getTime();
        if (state.lastHashRatePersistedAt > 0 && nowMs - state.lastHashRatePersistedAt < intervalMs) {
            return;
        }

        state.lastHashRatePersistedAt = nowMs;
        try {
            await this.clientService.updateHashRate(state.clientEntity.id, hashRate, now);
        } catch (error) {
            console.error(`Failed to persist DATUM client hashrate: ${error.message}`);
        }
    }

    private getHashRatePersistIntervalMs(): number {
        const configured = Number(this.configService.get<string>('CLIENT_HASHRATE_PERSIST_INTERVAL_MS'));
        if (Number.isFinite(configured) && configured >= 0) {
            return configured;
        }

        return DEFAULT_CLIENT_HASHRATE_PERSIST_INTERVAL_MS;
    }

    private async destroyClient(state: DatumClientState): Promise<void> {
        this.stopDatumPing(state);
        if (state.clientEntity?.id == null) {
            return;
        }
        await this.clientService.delete(state.clientEntity.id);
        state.clientEntity = null;
    }

    private startDatumPing(socket: Socket, state: DatumClientState): void {
        this.stopDatumPing(state);
        state.pingTimer = setInterval(() => {
            if (socket.destroyed || socket.writableEnded) {
                this.stopDatumPing(state);
                return;
            }
            void this.writeRaw(
                socket,
                state.session.encryptChannelFrame(DatumProtocolCommand.PING, Buffer.alloc(0)),
            ).catch(error => {
                console.error(`[DATUM ${state.sessionId}] ping failed: ${error.message}`);
                if (!socket.destroyed) {
                    socket.destroy();
                }
            });
        }, this.getDatumPingIntervalMs());
        state.pingTimer.unref?.();
    }

    private stopDatumPing(state: DatumClientState): void {
        if (state.pingTimer != null) {
            clearInterval(state.pingTimer);
            state.pingTimer = null;
        }
    }

    private async writeRaw(socket: Socket, data: Buffer): Promise<void> {
        if (socket.destroyed || socket.writableEnded) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            socket.write(data, error => error ? reject(error) : resolve());
        });
    }

    private parseUserIdentity(userIdentity: string): { address: string; workerName: string } {
        const parts = userIdentity.split('.');
        const address = parts[0] ?? '';
        return {
            address: this.normalizeAddress(address),
            workerName: parts.length > 1 ? parts.slice(1).join('.') : 'default',
        };
    }

    private normalizeAddress(address: string): string {
        if (/^(bc1|tb1|bcrt1)/i.test(address)) {
            return address.toLowerCase();
        }
        return address;
    }

    private isValidAddress(address: string): boolean {
        try {
            getAddressInfo(address);
            return true;
        } catch {
            return false;
        }
    }

    private getDatumPoolPayoutAddress(): string {
        return this.configService.get<string>('DATUM_POOL_PAYOUT_ADDRESS')
            || this.configService.get<string>('PAYOUT_FEE_ADDRESS')
            || this.configService.get<string>('DEV_FEE_ADDRESS')
            || '';
    }

    private getConfiguredDatumShareDifficulty(): number {
        const configured = parseFloat(this.configService.get<string>('DATUM_SHARE_DIFFICULTY') ?? '');
        return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DATUM_SHARE_DIFFICULTY;
    }

    private logVerbose(message: string): void {
        if (process.env.DATUM_VERBOSE_LOGGING?.toLowerCase() === 'true') {
            console.log(message);
        }
    }

    private getDatumSubmittedShareDifficulty(pow: Pick<DatumPowSubmit, 'targetByte'>): number {
        if (!Number.isInteger(pow.targetByte) || pow.targetByte < 0 || pow.targetByte > 63) {
            return this.getConfiguredDatumShareDifficulty();
        }
        return Math.pow(2, pow.targetByte);
    }

    private mapDatumTemplateRejectReason(errorCode?: string): DatumRejectReason {
        switch (errorCode) {
            case 'prevhash-mismatch':
            case 'height-mismatch':
                return DatumRejectReason.STALE_BLOCK;
            case 'nbits-mismatch':
            case 'weight-limit-exceeded':
            case 'size-limit-exceeded':
            case 'sigop-limit-exceeded':
            case 'coinbase-value-too-high':
                return DatumRejectReason.OTHER;
            case 'version-mismatch':
                return DatumRejectReason.BAD_VERSION;
            case 'bad-merkle-branch':
                return DatumRejectReason.BAD_MERKLE_COUNT;
            default:
                return DatumRejectReason.OTHER;
        }
    }

    private getDatumPingIntervalMs(): number {
        const configured = parseInt(this.configService.get<string>('DATUM_PING_INTERVAL_MS') ?? '', 10);
        return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DATUM_PING_INTERVAL_MS;
    }

    private getIdentityKeys(): DatumKeyPair {
        const seedHex = this.configService.get<string>('DATUM_IDENTITY_SEED')?.trim();
        if (!seedHex) {
            const keys = DatumCryptoSession.generateKeyPair();
            console.warn('DATUM_IDENTITY_SEED is not set; generated an ephemeral DATUM server identity key');
            return keys;
        }
        if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) {
            throw new Error('DATUM_IDENTITY_SEED must be a 32-byte hex string');
        }
        return DatumCryptoSession.generateKeyPairFromSeed(Buffer.from(seedHex, 'hex'));
    }

    private getPorts(): { port: number; payoutMode: PayoutMode }[] {
        return parsePayoutModePorts(
            this.configService.get<string>('DATUM_PORTS'),
            this.configService.get<string>('PPLNS_DATUM_PORTS'),
        );
    }

    private getNetwork(): bitcoinjs.networks.Network {
        const networkConfig = this.configService.get('NETWORK');
        if (networkConfig === 'mainnet') {
            return bitcoinjs.networks.bitcoin;
        }
        if (networkConfig === 'testnet') {
            return bitcoinjs.networks.testnet;
        }
        if (networkConfig === 'regtest') {
            return bitcoinjs.networks.regtest;
        }
        throw new Error('Invalid network configuration');
    }
}

interface DatumClientState {
    sessionId: string;
    payoutMode: PayoutMode;
    session: DatumCryptoSession;
    clientEntity: ClientEntity | null;
    address: string | null;
    workerName: string;
    userAgent: string;
    pingTimer: NodeJS.Timeout | null;
    datumJobs: Map<number, DatumJobCache>;
    coinbaserPayoutContexts: Map<number, DatumCoinbaserPayoutContext>;
    nextCoinbaserId: number;
    statistics: StratumV1ClientStatistics;
    lastHashRatePersistedAt: number;
    coinbaseMismatchLogged?: boolean;
}

interface DatumCoinbaserPayoutContext {
    payoutOutputs: DatumPayoutOutput[];
    payoutSnapshotId?: string | null;
    blockHeight?: number;
    payoutMode?: PayoutMode;
}

interface DatumJobCache {
    prevBlockHash?: Buffer;
    targetByteIndex?: number;
    nBits?: Buffer;
    coinbaserId?: number;
    height?: number;
    coinbaseValue?: bigint;
    transactionCount?: number;
    totalWeight?: number;
    totalSize?: number;
    totalSigops?: number;
    merkleBranches?: Buffer[];
    coinbasePairs: Map<number, { coinb1: Buffer; coinb2: Buffer }>;
    subsidyOnlyCoinbase?: { coinb1: Buffer; coinb2: Buffer };
    validationState?: 'requested-short-txids' | 'requested-full-transaction-blob' | 'validated' | 'failed';
    validationRequestedAt?: Date;
    validationCompletedAt?: Date;
    validationShortTxIds?: Buffer[];
    validationShortTxCrosscheck?: Buffer;
    validationTransactions?: Buffer[];
    validationError?: string;
    expectedPayoutOutputs?: DatumPayoutOutput[];
    payoutSnapshotId?: string | null;
}

interface DatumCoinbasePayoutValidation {
    valid: boolean;
    expectedOutputs: DatumPayoutOutput[];
    submittedOutputs: DatumPayoutOutput[];
    error?: string;
}

function uint32le(value: number): Buffer {
    const result = Buffer.alloc(4);
    result.writeUInt32LE(value >>> 0, 0);
    return result;
}
