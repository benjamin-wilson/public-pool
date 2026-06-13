import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bitcoinjs from 'bitcoinjs-lib';
import { Server, Socket } from 'net';

import { BlocksService } from '../ORM/blocks/blocks.service';
import { PayoutSnapshotService } from '../ORM/payout-snapshot/payout-snapshot.service';
import { BufferReader } from '../models/sv2/sv2-binary-codec';
import { SV2_NOISE_ACT1_SIZE, Sv2JdpSetupFlags, Sv2MsgType, Sv2Protocol } from '../models/sv2/sv2-constants';
import { Sv2FrameReader, Sv2FrameWriter } from '../models/sv2/sv2-frame';
import {
    deserializeAllocateMiningJobToken,
    deserializeDeclareMiningJob,
    deserializeProvideMissingTransactionsSuccess,
    deserializePushSolution,
    serializeAllocateMiningJobTokenSuccess,
    serializeDeclareMiningJobError,
    serializeDeclareMiningJobSuccess,
    serializeProvideMissingTransactions,
    Sv2DeclareMiningJob,
} from '../models/sv2/sv2-jdp-messages';
import {
    deserializeSetupConnection,
    serializeSetupConnectionError,
    serializeSetupConnectionSuccess,
} from '../models/sv2/sv2-messages';
import { Sv2NoiseSession } from '../models/sv2/sv2-noise';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { CustomWorkService } from './custom-work.service';
import { NotificationService } from './notification.service';
import { StratumV2Service } from './stratum-v2.service';
import { Sv2DeclaredMiningJob, Sv2JobDeclarationRegistryService } from './sv2-job-declaration-registry.service';
import { TemplateProviderService } from './template-provider.service';

@Injectable()
export class Sv2JobDeclarationService implements OnModuleInit {
    private readonly servers: Server[] = [];

    constructor(
        private readonly configService: ConfigService,
        private readonly stratumV2Service: StratumV2Service,
        private readonly registry: Sv2JobDeclarationRegistryService,
        private readonly customWorkService: CustomWorkService,
        private readonly templateProvider: TemplateProviderService,
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly blocksService: BlocksService,
        private readonly payoutSnapshotService: PayoutSnapshotService,
        private readonly notificationService: NotificationService,
    ) {}

    public async onModuleInit(): Promise<void> {
        if (process.env.API_ONLY === 'true' || process.env.MASTER === 'true') {
            return;
        }

        const ports = this.getPorts();
        if (ports.length === 0) {
            return;
        }

        await this.stratumV2Service.ensureInitialized();
        for (const port of ports) {
            this.startServer(port);
        }
    }

    private startServer(port: number): void {
        const server = new Server(socket => {
            void new Sv2JobDeclarationConnection(
                socket,
                this.stratumV2Service,
                this.registry,
                this.customWorkService,
                this.templateProvider,
                this.bitcoinRpcService,
                this.blocksService,
                this.payoutSnapshotService,
                this.notificationService,
                this.getPoolPayoutAddress(),
                this.getNetwork(),
            ).start();
        });
        server.on('error', error => console.error(`SV2 JDP server error on port ${port}: ${error.message}`));
        server.listen(port, () => console.log(`SV2 Job Declaration server is listening on port ${port}`));
        this.servers.push(server);
    }

    private getPoolPayoutAddress(): string {
        return this.configService.get<string>('SV2_JDP_POOL_PAYOUT_ADDRESS')
            || this.configService.get<string>('DATUM_POOL_PAYOUT_ADDRESS')
            || this.configService.get<string>('PAYOUT_FEE_ADDRESS')
            || this.configService.get<string>('DEV_FEE_ADDRESS')
            || '';
    }

    private getPorts(): number[] {
        const configured = this.configService.get<string>('SV2_JDP_PORTS');
        if (!configured?.trim()) {
            return [];
        }
        return Array.from(new Set(configured
            .split(',')
            .map(port => parseInt(port.trim(), 10))
            .filter(port => Number.isInteger(port) && port > 0 && port <= 65535)));
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

export class Sv2JobDeclarationConnection {
    private readonly noiseSession: Sv2NoiseSession;
    private readonly frameReader = new Sv2FrameReader(null);
    private readonly frameWriter = new Sv2FrameWriter(null);
    private handshakeBuffer = Buffer.alloc(0);
    private handshakeComplete = false;
    private destroyed = false;
    private declareTxData = false;
    private latestDeclaredJob: Sv2DeclaredMiningJob | null = null;
    private readonly submittedSolutions = new Set<string>();
    private readonly pendingDeclarations = new Map<number, {
        job: Sv2DeclareMiningJob;
        templateId: bigint;
        template: ReturnType<TemplateProviderService['getLatestTemplate']>;
        unknownTxPositionList: number[];
    }>();

    constructor(
        private readonly socket: Socket,
        stratumV2Service: StratumV2Service,
        private readonly registry: Sv2JobDeclarationRegistryService,
        private readonly customWorkService: CustomWorkService,
        private readonly templateProvider: TemplateProviderService,
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly blocksService: BlocksService,
        private readonly payoutSnapshotService: PayoutSnapshotService,
        private readonly notificationService: NotificationService,
        private readonly poolPayoutAddress: string,
        private readonly network: bitcoinjs.networks.Network,
    ) {
        this.noiseSession = new Sv2NoiseSession(stratumV2Service.getNoiseConfig());
    }

    public async start(): Promise<void> {
        this.socket.setKeepAlive(true, 60_000);
        this.socket.setNoDelay(true);
        this.socket.on('data', data => void this.handleSocketData(data));
        this.socket.on('error', () => this.close());
        this.socket.on('close', () => this.destroyed = true);
    }

    private async handleSocketData(data: Buffer): Promise<void> {
        if (this.destroyed) {
            return;
        }
        try {
            if (!this.handshakeComplete) {
                await this.handleHandshakeData(data);
                return;
            }
            await this.handleEncryptedData(data);
        } catch (error) {
            console.error(`[SV2 JDP] ${error.message}`);
            this.close();
        }
    }

    private async handleHandshakeData(data: Buffer): Promise<void> {
        this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, data]);
        if (this.handshakeBuffer.length < SV2_NOISE_ACT1_SIZE) {
            return;
        }
        const act1 = this.handshakeBuffer.subarray(0, SV2_NOISE_ACT1_SIZE);
        const remainder = Buffer.from(this.handshakeBuffer.subarray(SV2_NOISE_ACT1_SIZE));
        this.handshakeBuffer = Buffer.alloc(0);

        await this.writeRaw(await this.noiseSession.processAct1(Buffer.from(act1)));
        this.frameReader.setDecryptFn(ciphertext => this.noiseSession.decrypt(ciphertext));
        this.frameWriter.setEncryptFn(plaintext => this.noiseSession.encrypt(plaintext));
        this.handshakeComplete = true;
        if (remainder.length > 0) {
            await this.handleEncryptedData(remainder);
        }
    }

    private async handleEncryptedData(data: Buffer): Promise<void> {
        for (const frame of this.frameReader.feed(data)) {
            switch (frame.header.msgType) {
                case Sv2MsgType.SETUP_CONNECTION:
                    await this.handleSetupConnection(frame.payload);
                    break;
                case Sv2MsgType.JDP_ALLOCATE_MINING_JOB_TOKEN:
                    await this.handleAllocateMiningJobToken(frame.payload);
                    break;
                case Sv2MsgType.JDP_DECLARE_MINING_JOB:
                    await this.handleDeclareMiningJob(frame.payload);
                    break;
                case Sv2MsgType.JDP_PROVIDE_MISSING_TRANSACTIONS_SUCCESS:
                    await this.handleProvideMissingTransactionsSuccess(frame.payload);
                    break;
                case Sv2MsgType.JDP_PUSH_SOLUTION:
                    await this.handlePushSolution(frame.payload);
                    break;
                default:
                    console.warn(`[SV2 JDP] Ignoring unsupported message type 0x${frame.header.msgType.toString(16)}`);
                    break;
            }
        }
    }

    private async handleSetupConnection(payload: Buffer): Promise<void> {
        const setup = deserializeSetupConnection(new BufferReader(payload));
        if (setup.protocol !== Sv2Protocol.JOB_DECLARATION) {
            await this.sendFrame(Sv2MsgType.SETUP_CONNECTION_ERROR, serializeSetupConnectionError({
                flags: 0,
                errorCode: 'unsupported-protocol',
            }));
            this.close();
            return;
        }

        this.declareTxData = (setup.flags & Sv2JdpSetupFlags.DECLARE_TX_DATA) !== 0;
        await this.sendFrame(Sv2MsgType.SETUP_CONNECTION_SUCCESS, serializeSetupConnectionSuccess({
            usedVersion: 2,
            flags: 0,
        }));
    }

    private async handleAllocateMiningJobToken(payload: Buffer): Promise<void> {
        const request = deserializeAllocateMiningJobToken(new BufferReader(payload));
        const token = this.registry.allocateToken(
            request.userIdentifier,
            this.buildPoolCoinbaseOutputs(request.userIdentifier),
        );
        await this.sendFrame(Sv2MsgType.JDP_ALLOCATE_MINING_JOB_TOKEN_SUCCESS, serializeAllocateMiningJobTokenSuccess({
            requestId: request.requestId,
            miningJobToken: token.token,
            coinbaseOutputs: token.coinbaseOutputs,
        }));
    }

    private async handleDeclareMiningJob(payload: Buffer): Promise<void> {
        const job = deserializeDeclareMiningJob(new BufferReader(payload));
        if (!this.declareTxData) {
            await this.sendFrame(Sv2MsgType.JDP_DECLARE_MINING_JOB_ERROR, serializeDeclareMiningJobError({
                requestId: job.requestId,
                errorCode: 'declare-tx-data-not-negotiated',
                errorDetails: Buffer.alloc(0),
            }));
            return;
        }

        try {
            const validation = this.templateProvider.validateDeclaredWtxids({
                version: job.version,
                coinbaseTxPrefix: job.coinbaseTxPrefix,
                wtxidList: job.wtxidList,
            });
            if (validation.errorCode === 'missing-transactions' && validation.template != null) {
                this.pendingDeclarations.set(job.requestId, {
                    job,
                    templateId: validation.template.templateId,
                    template: validation.template,
                    unknownTxPositionList: validation.unknownTxPositionList,
                });
                await this.sendFrame(Sv2MsgType.JDP_PROVIDE_MISSING_TRANSACTIONS, serializeProvideMissingTransactions({
                    requestId: job.requestId,
                    unknownTxPositionList: validation.unknownTxPositionList,
                }));
                return;
            }
            if (!validation.valid) {
                await this.sendFrame(Sv2MsgType.JDP_DECLARE_MINING_JOB_ERROR, serializeDeclareMiningJobError({
                    requestId: job.requestId,
                    errorCode: validation.errorCode ?? 'invalid-template',
                    errorDetails: Buffer.alloc(0),
                }));
                return;
            }

            const declared = this.registry.declareJob(job, {
                templateId: validation.template.templateId,
                template: validation.template,
                validationMode: 'full_template',
            });
            this.latestDeclaredJob = declared;
            await this.sendFrame(Sv2MsgType.JDP_DECLARE_MINING_JOB_SUCCESS, serializeDeclareMiningJobSuccess({
                requestId: job.requestId,
                newMiningJobToken: declared.token,
            }));
        } catch (error) {
            await this.sendFrame(Sv2MsgType.JDP_DECLARE_MINING_JOB_ERROR, serializeDeclareMiningJobError({
                requestId: job.requestId,
                errorCode: error.message,
                errorDetails: Buffer.alloc(0),
            }));
        }
    }

    private async handleProvideMissingTransactionsSuccess(payload: Buffer): Promise<void> {
        const response = deserializeProvideMissingTransactionsSuccess(new BufferReader(payload));
        const pending = this.pendingDeclarations.get(response.requestId);
        if (pending == null) {
            await this.sendFrame(Sv2MsgType.JDP_DECLARE_MINING_JOB_ERROR, serializeDeclareMiningJobError({
                requestId: response.requestId,
                errorCode: 'unknown-missing-transaction-request',
                errorDetails: Buffer.alloc(0),
            }));
            return;
        }

        const validation = await this.templateProvider.validateProvidedTransactions({
            expectedWtxids: pending.job.wtxidList,
            unknownTxPositionList: pending.unknownTxPositionList,
            transactionList: response.transactionList,
        });
        if (!validation.valid) {
            this.pendingDeclarations.delete(response.requestId);
            await this.sendFrame(Sv2MsgType.JDP_DECLARE_MINING_JOB_ERROR, serializeDeclareMiningJobError({
                requestId: response.requestId,
                errorCode: validation.errorCode ?? 'invalid-missing-transactions',
                errorDetails: Buffer.alloc(0),
            }));
            return;
        }

        try {
            const declared = this.registry.declareJob(pending.job, {
                templateId: pending.templateId,
                template: pending.template,
                validationMode: 'full_template',
                providedTransactions: response.transactionList,
            });
            this.latestDeclaredJob = declared;
            this.pendingDeclarations.delete(response.requestId);
            await this.sendFrame(Sv2MsgType.JDP_DECLARE_MINING_JOB_SUCCESS, serializeDeclareMiningJobSuccess({
                requestId: pending.job.requestId,
                newMiningJobToken: declared.token,
            }));
        } catch (error) {
            this.pendingDeclarations.delete(response.requestId);
            await this.sendFrame(Sv2MsgType.JDP_DECLARE_MINING_JOB_ERROR, serializeDeclareMiningJobError({
                requestId: response.requestId,
                errorCode: error.message,
                errorDetails: Buffer.alloc(0),
            }));
        }
    }

    private async handlePushSolution(payload: Buffer): Promise<void> {
        const solution = deserializePushSolution(new BufferReader(payload));
        const declared = this.latestDeclaredJob;
        if (declared == null) {
            console.warn('[SV2 JDP] PushSolution received before a mining job was declared');
            return;
        }

        const solutionKey = [
            solution.prevHash.toString('hex'),
            solution.extranonce.toString('hex'),
            solution.nonce.toString(16),
            solution.ntime.toString(16),
            solution.nBits.toString(16),
            solution.version.toString(16),
        ].join(':');
        if (this.submittedSolutions.has(solutionKey)) {
            return;
        }

        const template = declared.template
            ?? (declared.templateId == null
            ? this.templateProvider.getLatestTemplate()
            : this.templateProvider.getTemplate(declared.templateId));
        if (template == null) {
            console.warn('[SV2 JDP] PushSolution skipped because the declared template is no longer available');
            return;
        }

        try {
            const block = this.templateProvider.buildBlockFromDeclaredJobSolution({
                template,
                job: declared.job,
                providedTransactions: declared.providedTransactions,
                solution,
            });
            const coinbaseValidation = this.templateProvider.validateCoinbaseTransactionHeight(
                block.transactions[0].toBuffer(),
                template.height,
            );
            if (!coinbaseValidation.valid) {
                console.warn(`[SV2 JDP] PushSolution rejected locally: ${coinbaseValidation.errorCode}`);
                return;
            }
            const blockHex = block.toHex(false);
            this.submittedSolutions.add(solutionKey);
            const result = await this.bitcoinRpcService.SUBMIT_BLOCK(blockHex);
            const { address, worker } = this.parseUserIdentifier(declared.userIdentifier);
            await this.blocksService.save({
                height: template.height,
                minerAddress: address,
                worker,
                sessionId: declared.token.toString('hex').slice(0, 8),
                blockData: blockHex,
                blockSubmissionResult: result,
                payoutSnapshotId: template.jobTemplate.blockData.payoutSnapshotId ?? null,
            });
            await this.payoutSnapshotService.finalizeSnapshotForBlock({
                payoutSnapshotId: template.jobTemplate.blockData.payoutSnapshotId,
                blockHeight: template.height,
                blockSubmissionResult: result,
            });
            await this.notificationService.notifySubscribersBlockFound(address, template.height, block, result);
            console.log(`[SV2 JDP] PushSolution submitted block at height ${template.height}: ${result ?? 'accepted'}`);
        } catch (error) {
            console.error(`[SV2 JDP] PushSolution failed: ${error.message ?? error}`);
        }
    }

    private buildPoolCoinbaseOutputs(userIdentifier: string): Buffer {
        const address = this.poolPayoutAddress || userIdentifier.split('.')[0];
        const script = bitcoinjs.address.toOutputScript(address, this.network);
        const value = Buffer.alloc(8);
        return Buffer.concat([
            this.customWorkService.encodeBitcoinVarInt(1),
            value,
            this.customWorkService.encodeBitcoinVarInt(script.length),
            script,
        ]);
    }

    private parseUserIdentifier(userIdentifier: string): { address: string; worker: string } {
        const [address, ...workerParts] = userIdentifier.split('.');
        return {
            address: address || userIdentifier,
            worker: workerParts.join('.') || 'jdp',
        };
    }

    private async sendFrame(msgType: number, payload: Buffer): Promise<void> {
        await this.writeRaw(this.frameWriter.writeFrame({
            extensionType: 0,
            msgType,
            msgLength: payload.length,
        }, payload));
    }

    private async writeRaw(data: Buffer): Promise<void> {
        if (this.socket.destroyed || this.socket.writableEnded) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            this.socket.write(data, error => error ? reject(error) : resolve());
        });
    }

    private close(): void {
        this.destroyed = true;
        if (!this.socket.destroyed) {
            this.socket.destroy();
        }
    }
}
