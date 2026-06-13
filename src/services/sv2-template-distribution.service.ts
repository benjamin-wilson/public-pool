import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bitcoinjs from 'bitcoinjs-lib';
import { Server, Socket } from 'net';
import { Subscription } from 'rxjs';

import { BlocksService } from '../ORM/blocks/blocks.service';
import { PayoutSnapshotService } from '../ORM/payout-snapshot/payout-snapshot.service';
import { SV2_NOISE_ACT1_SIZE, Sv2MsgType, Sv2Protocol } from '../models/sv2/sv2-constants';
import { Sv2FrameReader, Sv2FrameWriter } from '../models/sv2/sv2-frame';
import { BufferReader } from '../models/sv2/sv2-binary-codec';
import {
    deserializeSetupConnection,
    serializeSetupConnectionError,
    serializeSetupConnectionSuccess,
} from '../models/sv2/sv2-messages';
import { AddressObject, MiningJob } from '../models/MiningJob';
import { Sv2NoiseSession } from '../models/sv2/sv2-noise';
import {
    deserializeTdpCoinbaseOutputConstraints,
    deserializeTdpRequestTransactionData,
    deserializeTdpSubmitSolution,
    serializeTdpNewTemplate,
    serializeTdpRequestTransactionDataError,
    serializeTdpRequestTransactionDataSuccess,
    serializeTdpSetNewPrevHash,
} from '../models/sv2/sv2-tdp-messages';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { NotificationService } from './notification.service';
import { IJobTemplate, StratumV1JobsService } from './stratum-v1-jobs.service';
import { StratumV2Service } from './stratum-v2.service';
import { TemplateProviderService, TemplateProviderTemplate } from './template-provider.service';

interface TdpCoinbaseTemplateFields {
    coinbaseTxVersion: number;
    coinbasePrefix: Buffer;
    coinbaseTxInputSequence: number;
    coinbaseTxValueRemaining: bigint;
    coinbaseTxOutputsCount: number;
    coinbaseTxOutputs: Buffer;
    coinbaseTxLocktime: number;
}

@Injectable()
export class Sv2TemplateDistributionService implements OnModuleInit {
    private readonly servers: Server[] = [];

    constructor(
        private readonly configService: ConfigService,
        private readonly stratumV2Service: StratumV2Service,
        private readonly jobsService: StratumV1JobsService,
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
            void new Sv2TemplateDistributionConnection(
                socket,
                this.stratumV2Service,
                this.jobsService,
                this.templateProvider,
                this.bitcoinRpcService,
                this.blocksService,
                this.payoutSnapshotService,
                this.notificationService,
                this.getPoolPayoutAddress(),
                this.getNetwork(),
            ).start();
        });
        server.on('error', error => console.error(`SV2 TDP server error on port ${port}: ${error.message}`));
        server.listen(port, () => console.log(`SV2 Template Distribution server is listening on port ${port}`));
        this.servers.push(server);
    }

    private getPorts(): number[] {
        const configured = this.configService.get<string>('SV2_TDP_PORTS');
        if (!configured?.trim()) {
            return [];
        }
        return Array.from(new Set(configured
            .split(',')
            .map(port => parseInt(port.trim(), 10))
            .filter(port => Number.isInteger(port) && port > 0 && port <= 65535)));
    }

    private getPoolPayoutAddress(): string {
        return this.configService.get<string>('SV2_TDP_POOL_PAYOUT_ADDRESS')
            || this.configService.get<string>('SV2_JDP_POOL_PAYOUT_ADDRESS')
            || this.configService.get<string>('DATUM_POOL_PAYOUT_ADDRESS')
            || this.configService.get<string>('PAYOUT_FEE_ADDRESS')
            || this.configService.get<string>('DEV_FEE_ADDRESS')
            || '';
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

export class Sv2TemplateDistributionConnection {
    private readonly noiseSession: Sv2NoiseSession;
    private readonly frameReader = new Sv2FrameReader(null);
    private readonly frameWriter = new Sv2FrameWriter(null);
    private handshakeBuffer = Buffer.alloc(0);
    private handshakeComplete = false;
    private destroyed = false;
    private subscription: Subscription | null = null;
    private readonly submittedSolutions = new Set<string>();
    private readonly servedTemplates = new Map<string, TemplateProviderTemplate>();

    constructor(
        private readonly socket: Socket,
        stratumV2Service: StratumV2Service,
        private readonly jobsService: StratumV1JobsService,
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
        this.socket.on('close', () => this.close());
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
            for (const frame of this.frameReader.feed(data)) {
                await this.handleFrame(frame.header.msgType, frame.payload);
            }
        } catch (error) {
            console.error(`[SV2 TDP] ${error.message}`);
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
            for (const frame of this.frameReader.feed(remainder)) {
                await this.handleFrame(frame.header.msgType, frame.payload);
            }
        }
    }

    private async handleFrame(msgType: number, payload: Buffer): Promise<void> {
        switch (msgType) {
            case Sv2MsgType.SETUP_CONNECTION:
                await this.handleSetupConnection(payload);
                break;
            case Sv2MsgType.TDP_COINBASE_OUTPUT_CONSTRAINTS:
                deserializeTdpCoinbaseOutputConstraints(new BufferReader(payload));
                this.subscribeTemplates();
                break;
            case Sv2MsgType.TDP_REQUEST_TRANSACTION_DATA: {
                const request = deserializeTdpRequestTransactionData(new BufferReader(payload));
                await this.handleRequestTransactionData(request.templateId);
                break;
            }
            case Sv2MsgType.TDP_SUBMIT_SOLUTION: {
                const solution = deserializeTdpSubmitSolution(new BufferReader(payload));
                await this.handleSubmitSolution(solution);
                break;
            }
            default:
                break;
        }
    }

    private async handleSetupConnection(payload: Buffer): Promise<void> {
        const setup = deserializeSetupConnection(new BufferReader(payload));
        if (setup.protocol !== Sv2Protocol.TEMPLATE_DISTRIBUTION) {
            await this.sendFrame(Sv2MsgType.SETUP_CONNECTION_ERROR, serializeSetupConnectionError({
                flags: 0,
                errorCode: 'unsupported-protocol',
            }));
            this.close();
            return;
        }

        await this.sendFrame(Sv2MsgType.SETUP_CONNECTION_SUCCESS, serializeSetupConnectionSuccess({
            usedVersion: 2,
            flags: 0,
        }));
    }

    private subscribeTemplates(): void {
        if (this.subscription != null) {
            return;
        }
        this.subscription = this.jobsService.newMiningJob$.subscribe({
            next: template => void this.sendTemplate(template),
            error: () => this.close(),
        });
    }

    private async sendTemplate(template: IJobTemplate): Promise<void> {
        const cachedTemplate = this.templateProvider.upsert(template);
        const templateId = BigInt(parseInt(template.blockData.id, 16));
        this.servedTemplates.set(templateId.toString(), cachedTemplate);
        const merklePath = template.merkle_branch.map(branch => Buffer.from(branch, 'hex'));
        const coinbase = this.buildCoinbaseTemplateFields(template);
        await this.sendFrame(Sv2MsgType.TDP_NEW_TEMPLATE, serializeTdpNewTemplate({
            templateId,
            futureTemplate: true,
            version: template.block.version,
            ...coinbase,
            merklePath,
        }));
        await this.sendFrame(Sv2MsgType.TDP_SET_NEW_PREV_HASH, serializeTdpSetNewPrevHash({
            templateId,
            prevHash: Buffer.from(template.block.prevHash),
            headerTimestamp: template.block.timestamp,
            nBits: template.block.bits,
            target: cachedTemplate.target,
        }));
    }

    private buildCoinbaseTemplateFields(template: IJobTemplate): TdpCoinbaseTemplateFields {
        const job = new MiningJob(
            this.network,
            template.blockData.id,
            this.getPayoutInformation(template),
            template,
        );
        const coinbaseTx = job.cloneCoinbaseTransaction();

        return {
            coinbaseTxVersion: coinbaseTx.version,
            coinbasePrefix: job.getCoinbasePrefixBuffer(),
            coinbaseTxInputSequence: coinbaseTx.ins[0]?.sequence ?? 0xffffffff,
            coinbaseTxValueRemaining: BigInt(template.blockData.coinbasevalue),
            coinbaseTxOutputsCount: coinbaseTx.outs.length,
            coinbaseTxOutputs: this.serializeCoinbaseOutputs(coinbaseTx),
            coinbaseTxLocktime: coinbaseTx.locktime,
        };
    }

    private getPayoutInformation(template: IJobTemplate): AddressObject[] {
        if (template.blockData.payoutOutputs?.length > 0) {
            return template.blockData.payoutOutputs;
        }

        return [{ address: this.poolPayoutAddress, percent: 100 }];
    }

    private serializeCoinbaseOutputs(coinbaseTx: bitcoinjs.Transaction): Buffer {
        return Buffer.concat(coinbaseTx.outs.map(output => {
            const value = Buffer.alloc(8);
            value.writeBigUInt64LE(BigInt(output.value), 0);
            return Buffer.concat([
                value,
                this.encodeBitcoinVarInt(output.script.length),
                Buffer.from(output.script),
            ]);
        }));
    }

    private encodeBitcoinVarInt(value: number): Buffer {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new RangeError(`Invalid Bitcoin varint value ${value}`);
        }
        if (value < 0xfd) {
            return Buffer.from([value]);
        }
        if (value <= 0xffff) {
            const result = Buffer.alloc(3);
            result[0] = 0xfd;
            result.writeUInt16LE(value, 1);
            return result;
        }
        if (value <= 0xffffffff) {
            const result = Buffer.alloc(5);
            result[0] = 0xfe;
            result.writeUInt32LE(value, 1);
            return result;
        }
        const result = Buffer.alloc(9);
        result[0] = 0xff;
        result.writeBigUInt64LE(BigInt(value), 1);
        return result;
    }

    private async handleRequestTransactionData(templateId: bigint): Promise<void> {
        const template = this.getServedOrProviderTemplate(templateId);
        if (template == null) {
            await this.sendFrame(Sv2MsgType.TDP_REQUEST_TRANSACTION_DATA_ERROR, serializeTdpRequestTransactionDataError({
                templateId,
                errorCode: 'template-not-found',
            }));
            return;
        }
        this.servedTemplates.set(templateId.toString(), template);

        await this.sendFrame(Sv2MsgType.TDP_REQUEST_TRANSACTION_DATA_SUCCESS, serializeTdpRequestTransactionDataSuccess({
            templateId,
            excessData: Buffer.alloc(0),
            transactionList: template.transactionList,
        }));
    }

    private async handleSubmitSolution(solution: ReturnType<typeof deserializeTdpSubmitSolution>): Promise<void> {
        const template = this.getServedOrProviderTemplate(solution.templateId);
        if (template == null) {
            await this.sendFrame(Sv2MsgType.TDP_REQUEST_TRANSACTION_DATA_ERROR, serializeTdpRequestTransactionDataError({
                templateId: solution.templateId,
                errorCode: 'template-not-found',
            }));
            return;
        }

        const coinbaseValidation = this.templateProvider.validateCoinbaseTransactionHeight(solution.coinbaseTx, template.height);
        if (!coinbaseValidation.valid) {
            console.warn(`[SV2 TDP] SubmitSolution rejected locally: ${coinbaseValidation.errorCode}`);
            return;
        }
        const block = this.templateProvider.buildBlockFromSolution({
            template,
            coinbaseTx: solution.coinbaseTx,
            version: solution.version,
            headerTimestamp: solution.headerTimestamp,
            headerNonce: solution.headerNonce,
        });
        const blockHex = block.toHex(false);
        const solutionKey = `${solution.templateId.toString()}:${block.getId()}`;
        if (this.submittedSolutions.has(solutionKey)) {
            return;
        }
        this.submittedSolutions.add(solutionKey);
        const result = await this.bitcoinRpcService.SUBMIT_BLOCK(blockHex);
        await this.blocksService.save({
            height: template.height,
            minerAddress: this.poolPayoutAddress || 'sv2-tdp',
            worker: 'tdp',
            sessionId: solution.templateId.toString(16).slice(-8).padStart(8, '0'),
            blockData: blockHex,
            blockSubmissionResult: result,
            payoutSnapshotId: template.jobTemplate.blockData.payoutSnapshotId ?? null,
        });
        await this.payoutSnapshotService.finalizeSnapshotForBlock({
            payoutSnapshotId: template.jobTemplate.blockData.payoutSnapshotId,
            blockHeight: template.height,
            blockSubmissionResult: result,
        });
        await this.notificationService.notifySubscribersBlockFound(
            this.poolPayoutAddress || 'sv2-tdp',
            template.height,
            block,
            result,
        );
        if (result != null && result !== 'SUCCESS!') {
            console.warn(`[SV2 TDP] SubmitSolution rejected: ${result}`);
        }
    }

    private getServedOrProviderTemplate(templateId: bigint): TemplateProviderTemplate | undefined {
        return this.servedTemplates.get(templateId.toString())
            ?? this.templateProvider.getTemplate(templateId);
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
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        this.subscription?.unsubscribe();
        this.subscription = null;
        if (!this.socket.destroyed) {
            this.socket.destroy();
        }
    }
}
