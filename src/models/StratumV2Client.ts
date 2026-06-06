import { ConfigService } from '@nestjs/config';
import { getAddressInfo } from 'bitcoin-address-validation';
import * as bitcoinjs from 'bitcoinjs-lib';
import * as crypto from 'crypto';
import { Socket } from 'net';
import { firstValueFrom, Subscription } from 'rxjs';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { NotificationService } from '../services/notification.service';
import { StratumV2Service } from '../services/stratum-v2.service';
import { IJobTemplate, StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { patchCoinbasePrefixVarint } from '../utils/coinbase-prefix.utils';
import { DifficultyUtils } from '../utils/difficulty.utils';
import { MiningJob } from './MiningJob';
import { StratumV1ClientStatistics } from './StratumV1ClientStatistics';
import { TOTAL_EXTRANONCE_SIZE_BYTES } from './stratum.constants';
import { BufferReader } from './sv2/sv2-binary-codec';
import {
    SV2_CHANNEL_MSG_FLAG,
    SV2_NOISE_ACT1_SIZE,
    Sv2MiningSetupFlags,
    Sv2MiningSetupSuccessFlags,
    Sv2MsgType,
    Sv2Protocol,
} from './sv2/sv2-constants';
import { Sv2FrameReader, Sv2FrameWriter } from './sv2/sv2-frame';
import {
    deserializeCloseChannel,
    deserializeOpenStandardMiningChannel,
    deserializeRequestExtensions,
    deserializeSetupConnection,
    deserializeSubmitSharesStandard,
    deserializeUpdateChannel,
    serializeOpenMiningChannelError,
    serializeOpenStandardMiningChannelSuccess,
    serializeNewMiningJob,
    serializeRequestExtensionsSuccess,
    serializeSetNewPrevHash,
    serializeSetTarget,
    serializeSetupConnectionError,
    serializeSetupConnectionSuccess,
    serializeSubmitSharesError,
    serializeSubmitSharesSuccess,
} from './sv2/sv2-messages';
import {
    deserializeOpenExtendedMiningChannel,
    deserializeSubmitSharesExtended,
    serializeNewExtendedMiningJob,
    serializeOpenExtendedMiningChannelSuccess,
    Sv2SubmitSharesExtended,
} from './sv2/sv2-extended-messages';
import { Sv2NoiseSession } from './sv2/sv2-noise';

const DEFAULT_START_DIFFICULTY = 100000;
const DEFAULT_TARGET_SHARES_PER_MINUTE = 2;
const DEFAULT_DIFFICULTY_CHECK_INTERVAL_MS = 60 * 1000;
const FIXED_STANDARD_EXTRANONCE2 = '0000000000000000';
const RETIRED_EXTENDED_JOB_RETENTION_MS = 5 * 60 * 1000;
const SV2_AUTH_FAILURE_LOG_INTERVAL_MS = 60 * 1000;

interface ExtendedJobData {
    coinbasePrefix: Buffer;
    coinbaseSuffix: Buffer;
    merklePath: Buffer[];
    prevHash: Buffer;
    nBits: number;
    minNtime: number;
    jobTemplate: IJobTemplate;
    miningJob: MiningJob;
    retiredAt?: number;
    creation: number;
}

interface ChannelState {
    channelId: number;
    channelType: 'standard' | 'extended';
    extranoncePrefix: Buffer;
    extranonceSize: number;
    sessionDifficulty: number;
    declaredMaxTarget: Buffer;
    jobIdToDifficulty: Map<number, number>;
    jobIdToMerkleRoot: Map<number, Buffer>;
    extendedJobs: Map<number, ExtendedJobData>;
    latestExtendedPrevHash: Buffer;
    latestExtendedNBits: number;
    latestExtendedMinNtime: number;
    miningSubmissionHashes: Set<string>;
    acceptedShareCount: number;
}

export class StratumV2Client {
    private static authFailureLogState = new Map<string, { nextLogAt: number; suppressed: number }>();

    private readonly sessionId = crypto.randomBytes(4).toString('hex');
    private readonly noiseSession: Sv2NoiseSession;
    private readonly frameReader = new Sv2FrameReader(null);
    private readonly frameWriter = new Sv2FrameWriter(null);
    private readonly statistics: StratumV1ClientStatistics;
    private readonly network: bitcoinjs.networks.Network;
    private readonly targetSharesPerMinute: number;
    private readonly difficultyCheckIntervalMs: number;

    private handshakeBuffer = Buffer.alloc(0);
    private handshakeComplete = false;
    private processingHandshake = false;
    private destroyed = false;
    private stratumSubscription: Subscription = null;
    private difficultyTimer: NodeJS.Timeout = null;
    private channels = new Map<number, ChannelState>();
    private primaryChannelId: number = null;
    private address: string = null;
    private workerName = 'default';
    private userAgent = 'unknown/sv2';
    private sessionDifficulty: number;
    private clientEntity: ClientEntity = null;
    private creatingEntity: Promise<void> = null;
    private readonly firstChunkSummary: string;

    constructor(
        private readonly socket: Socket,
        firstChunk: Buffer,
        private readonly stratumV2Service: StratumV2Service,
        private readonly stratumV1JobsService: StratumV1JobsService,
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly notificationService: NotificationService,
        private readonly blocksService: BlocksService,
        private readonly configService: ConfigService,
        private readonly addressSettingsService: AddressSettingsService,
    ) {
        this.firstChunkSummary = this.describeChunk(firstChunk);
        this.noiseSession = new Sv2NoiseSession(this.stratumV2Service.getNoiseConfig());
        this.sessionDifficulty = this.getInitialDifficulty();
        this.targetSharesPerMinute = this.getTargetSharesPerMinute();
        this.difficultyCheckIntervalMs = this.getDifficultyCheckIntervalMs();
        this.statistics = new StratumV1ClientStatistics(this.clientStatisticsService);
        this.statistics.targetSubmitShareEveryNSeconds = 60 / this.targetSharesPerMinute;
        this.network = this.getNetwork();

        this.socket.on('data', (data: Buffer) => {
            void this.handleSocketData(data);
        });

        void this.handleSocketData(firstChunk);
    }

    public async destroy(): Promise<void> {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;

        if (this.stratumSubscription != null) {
            this.stratumSubscription.unsubscribe();
            this.stratumSubscription = null;
        }
        if (this.difficultyTimer != null) {
            clearInterval(this.difficultyTimer);
            this.difficultyTimer = null;
        }
        for (const channel of this.channels.values()) {
            if (channel.channelType === 'extended') {
                this.stratumV2Service.releaseExtendedExtranoncePrefix(channel.channelId);
            }
        }
        this.channels.clear();
        if (this.clientEntity?.id != null) {
            await this.clientService.delete(this.clientEntity.id);
        }
    }

    private async handleSocketData(data: Buffer): Promise<void> {
        if (this.destroyed) {
            return;
        }

        try {
            if (!this.handshakeComplete) {
                await this.handleHandshakeData(data);
            } else {
                await this.handleEncryptedData(data);
            }
        } catch (error) {
            this.logProtocolError(error);
            this.closeSocket();
        }
    }

    private async handleHandshakeData(data: Buffer): Promise<void> {
        this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, data]);
        if (this.processingHandshake || this.handshakeBuffer.length < SV2_NOISE_ACT1_SIZE) {
            return;
        }

        this.processingHandshake = true;
        const act1 = this.handshakeBuffer.subarray(0, SV2_NOISE_ACT1_SIZE);
        const remainder = Buffer.from(this.handshakeBuffer.subarray(SV2_NOISE_ACT1_SIZE));
        this.handshakeBuffer = Buffer.alloc(0);

        const act2 = await this.noiseSession.processAct1(Buffer.from(act1));
        await this.writeRaw(act2);

        this.frameReader.setDecryptFn(ciphertext => this.noiseSession.decrypt(ciphertext));
        this.frameWriter.setEncryptFn(plaintext => this.noiseSession.encrypt(plaintext));
        this.handshakeComplete = true;
        this.processingHandshake = false;

        if (remainder.length > 0) {
            await this.handleEncryptedData(remainder);
        }
    }

    private async handleEncryptedData(data: Buffer): Promise<void> {
        const frames = this.frameReader.feed(data);
        for (const frame of frames) {
            await this.handleFrame(frame.header.msgType, frame.header.extensionType, frame.payload);
        }
    }

    private async handleFrame(msgType: number, extensionType: number, payload: Buffer): Promise<void> {
        if ((extensionType & ~SV2_CHANNEL_MSG_FLAG) === 0x0001 && msgType === 0x00) {
            const request = deserializeRequestExtensions(new BufferReader(payload));
            await this.sendFrame(
                0x01,
                serializeRequestExtensionsSuccess({
                    requestId: request.requestId,
                    supportedExtensions: [],
                }),
                0x0001,
            );
            return;
        }

        switch (msgType) {
            case Sv2MsgType.SETUP_CONNECTION:
                await this.handleSetupConnection(payload);
                break;
            case Sv2MsgType.OPEN_STANDARD_MINING_CHANNEL:
                await this.handleOpenStandardMiningChannel(payload);
                break;
            case Sv2MsgType.OPEN_EXTENDED_MINING_CHANNEL:
                await this.handleOpenExtendedMiningChannel(payload);
                break;
            case Sv2MsgType.SUBMIT_SHARES_STANDARD:
                await this.handleSubmitSharesStandard(payload);
                break;
            case Sv2MsgType.SUBMIT_SHARES_EXTENDED:
                await this.handleSubmitSharesExtended(payload);
                break;
            case Sv2MsgType.UPDATE_CHANNEL:
                await this.handleUpdateChannel(payload);
                break;
            case Sv2MsgType.CLOSE_CHANNEL:
                this.handleCloseChannel(payload);
                break;
            default:
                console.warn(`[SV2 ${this.sessionId}] Ignoring unsupported message type 0x${msgType.toString(16)}`);
                break;
        }
    }

    private async handleSetupConnection(payload: Buffer): Promise<void> {
        const message = deserializeSetupConnection(new BufferReader(payload));
        this.userAgent = `${message.vendor || 'unknown'}/sv2`;

        if (message.protocol !== Sv2Protocol.MINING) {
            await this.sendFrame(
                Sv2MsgType.SETUP_CONNECTION_ERROR,
                serializeSetupConnectionError({
                    flags: 0,
                    errorCode: 'unsupported-protocol',
                }),
            );
            this.closeSocket();
            return;
        }

        if (message.minVersion > 2 || message.maxVersion < 2) {
            await this.sendFrame(
                Sv2MsgType.SETUP_CONNECTION_ERROR,
                serializeSetupConnectionError({
                    flags: 0,
                    errorCode: 'protocol-version-mismatch',
                }),
            );
            this.closeSocket();
            return;
        }

        const supportedFlags = Sv2MiningSetupFlags.REQUIRES_STANDARD_JOBS
            | Sv2MiningSetupFlags.REQUIRES_VERSION_ROLLING;
        const unsupportedFlags = message.flags & ~supportedFlags;
        if (unsupportedFlags !== 0) {
            await this.sendFrame(
                Sv2MsgType.SETUP_CONNECTION_ERROR,
                serializeSetupConnectionError({
                    flags: unsupportedFlags,
                    errorCode: 'unsupported-feature-flags',
                }),
            );
            this.closeSocket();
            return;
        }

        const versionRolling = (message.flags & Sv2MiningSetupFlags.REQUIRES_VERSION_ROLLING) !== 0;
        const successFlags = versionRolling ? 0 : Sv2MiningSetupSuccessFlags.REQUIRES_FIXED_VERSION;
        await this.sendFrame(
            Sv2MsgType.SETUP_CONNECTION_SUCCESS,
            serializeSetupConnectionSuccess({
                usedVersion: 2,
                flags: successFlags,
            }),
        );
    }

    private async handleOpenStandardMiningChannel(payload: Buffer): Promise<void> {
        const message = deserializeOpenStandardMiningChannel(new BufferReader(payload));
        const { address, workerName } = this.parseUserIdentity(message.user_identity);

        if (!this.isValidAddress(address)) {
            await this.sendOpenChannelError(message.requestId, 'unknown-user');
            this.closeSocket();
            return;
        }

        if (this.address != null && this.address !== address) {
            await this.sendOpenChannelError(message.requestId, 'unknown-user');
            return;
        }

        if (message.maxTarget.length !== 32 || message.maxTarget.every(byte => byte === 0)) {
            await this.sendOpenChannelError(message.requestId, 'max-target-out-of-range');
            return;
        }

        const isFirstChannel = this.channels.size === 0;
        if (isFirstChannel) {
            this.address = address;
            this.workerName = workerName;
        }

        const channelId = this.stratumV2Service.getNextChannelId();
        const extranoncePrefix = this.stratumV2Service.generateExtranoncePrefix();
        let channelDifficulty = this.sessionDifficulty;
        if (Number.isFinite(message.nominalHashRate) && message.nominalHashRate > 0) {
            const calculatedDifficulty = DifficultyUtils.hashRateToDifficulty(
                message.nominalHashRate,
                this.targetSharesPerMinute,
            );
            if (Number.isFinite(calculatedDifficulty) && calculatedDifficulty > 0) {
                channelDifficulty = calculatedDifficulty;
            }
        }
        channelDifficulty = DifficultyUtils.clampDifficultyToMaxTarget(channelDifficulty, message.maxTarget);
        this.sessionDifficulty = channelDifficulty;

        const channel: ChannelState = {
            channelId,
            channelType: 'standard',
            extranoncePrefix,
            extranonceSize: Buffer.byteLength(FIXED_STANDARD_EXTRANONCE2, 'hex'),
            sessionDifficulty: channelDifficulty,
            declaredMaxTarget: Buffer.from(message.maxTarget),
            jobIdToDifficulty: new Map(),
            jobIdToMerkleRoot: new Map(),
            extendedJobs: new Map(),
            latestExtendedPrevHash: Buffer.alloc(32),
            latestExtendedNBits: 0,
            latestExtendedMinNtime: 0,
            miningSubmissionHashes: new Set(),
            acceptedShareCount: 0,
        };
        this.channels.set(channelId, channel);
        if (this.primaryChannelId == null) {
            this.primaryChannelId = channelId;
        }

        await this.ensureClientEntity();
        await this.sendFrame(
            Sv2MsgType.OPEN_STANDARD_MINING_CHANNEL_SUCCESS,
            serializeOpenStandardMiningChannelSuccess({
                requestId: message.requestId,
                channelId,
                target: DifficultyUtils.difficultyToTarget(channel.sessionDifficulty),
                extranonce_prefix: channel.extranoncePrefix,
                groupChannelId: 0,
            }),
        );

        const jobTemplate = await firstValueFrom(this.stratumV1JobsService.newMiningJob$);
        await this.sendNewMiningJob(channel, jobTemplate, true);

        if (isFirstChannel) {
            this.subscribeToJobs();
            this.startDifficultyTimer();
        }
    }

    private async handleOpenExtendedMiningChannel(payload: Buffer): Promise<void> {
        const message = deserializeOpenExtendedMiningChannel(new BufferReader(payload));
        const { address, workerName } = this.parseUserIdentity(message.userIdentity);

        if (!this.isValidAddress(address)) {
            await this.sendOpenChannelError(message.requestId, 'unknown-user');
            this.closeSocket();
            return;
        }

        if (this.address != null && this.address !== address) {
            await this.sendOpenChannelError(message.requestId, 'unknown-user');
            return;
        }

        if (message.maxTarget.length !== 32 || message.maxTarget.every(byte => byte === 0)) {
            await this.sendOpenChannelError(message.requestId, 'max-target-out-of-range');
            return;
        }

        const isFirstChannel = this.channels.size === 0;
        if (isFirstChannel) {
            this.address = address;
            this.workerName = workerName;
        }

        const channelId = this.stratumV2Service.getNextChannelId();
        const extranoncePrefix = this.stratumV2Service.allocateExtendedExtranoncePrefix(channelId);
        const maxMinerExtranonceSize = Math.max(0, TOTAL_EXTRANONCE_SIZE_BYTES - extranoncePrefix.length);
        const defaultMinerExtranonceSize = Math.min(
            this.stratumV2Service.getExtendedMinerExtranonceSize(),
            maxMinerExtranonceSize,
        );
        const extranonceSize = message.minExtranonceSize > 0
            ? Math.min(message.minExtranonceSize, maxMinerExtranonceSize)
            : defaultMinerExtranonceSize;

        let channelDifficulty = this.sessionDifficulty;
        if (Number.isFinite(message.nominalHashRate) && message.nominalHashRate > 0) {
            const calculatedDifficulty = DifficultyUtils.hashRateToDifficulty(
                message.nominalHashRate,
                this.targetSharesPerMinute,
            );
            if (Number.isFinite(calculatedDifficulty) && calculatedDifficulty > 0) {
                channelDifficulty = calculatedDifficulty;
            }
        }
        channelDifficulty = DifficultyUtils.clampDifficultyToMaxTarget(channelDifficulty, message.maxTarget);
        this.sessionDifficulty = channelDifficulty;

        const channel: ChannelState = {
            channelId,
            channelType: 'extended',
            extranoncePrefix,
            extranonceSize,
            sessionDifficulty: channelDifficulty,
            declaredMaxTarget: Buffer.from(message.maxTarget),
            jobIdToDifficulty: new Map(),
            jobIdToMerkleRoot: new Map(),
            extendedJobs: new Map(),
            latestExtendedPrevHash: Buffer.alloc(32),
            latestExtendedNBits: 0,
            latestExtendedMinNtime: 0,
            miningSubmissionHashes: new Set(),
            acceptedShareCount: 0,
        };
        this.channels.set(channelId, channel);
        if (this.primaryChannelId == null) {
            this.primaryChannelId = channelId;
        }

        await this.ensureClientEntity();
        await this.sendFrame(
            Sv2MsgType.OPEN_EXTENDED_MINING_CHANNEL_SUCCESS,
            serializeOpenExtendedMiningChannelSuccess({
                requestId: message.requestId,
                channelId,
                target: DifficultyUtils.difficultyToTarget(channel.sessionDifficulty),
                extranonceSize,
                extranoncePrefix,
                groupChannelId: 0,
            }),
        );

        const jobTemplate = await firstValueFrom(this.stratumV1JobsService.newMiningJob$);
        await this.sendNewExtendedMiningJob(channel, jobTemplate, true);

        if (isFirstChannel) {
            this.subscribeToJobs();
            this.startDifficultyTimer();
        }
    }

    private async handleSubmitSharesStandard(payload: Buffer): Promise<void> {
        const submission = deserializeSubmitSharesStandard(new BufferReader(payload));
        const channel = this.channels.get(submission.channelId);
        if (channel == null) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'invalid-channel-id');
            return;
        }

        const submissionKey = [
            submission.jobId,
            submission.nonce,
            submission.ntime,
            submission.version,
        ].join(':');
        if (channel.miningSubmissionHashes.has(submissionKey)) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'stale-share');
            return;
        }
        channel.miningSubmissionHashes.add(submissionKey);
        if (channel.miningSubmissionHashes.size > 10000) {
            channel.miningSubmissionHashes.clear();
        }

        const jobIdHex = submission.jobId.toString(16);
        const job = this.stratumV1JobsService.getJobById(jobIdHex);
        const sentMerkleRoot = channel.jobIdToMerkleRoot.get(submission.jobId);
        if (job == null || sentMerkleRoot == null) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'invalid-job-id');
            return;
        }

        const jobTemplate = this.stratumV1JobsService.getJobTemplateById(job.jobTemplateId);
        if (jobTemplate == null) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'invalid-job-id');
            return;
        }

        const header = this.buildHeader(jobTemplate, sentMerkleRoot, submission.version, submission.ntime, submission.nonce);
        const { submissionDifficulty, hashBuffer } = DifficultyUtils.calculateDifficulty(header);
        const jobDifficulty = channel.jobIdToDifficulty.get(submission.jobId) ?? channel.sessionDifficulty;
        const target = DifficultyUtils.difficultyToTarget(jobDifficulty);

        if (!DifficultyUtils.meetsTarget(hashBuffer, target)) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'difficulty-too-low');
            return;
        }

        await this.sendFrame(
            Sv2MsgType.SUBMIT_SHARES_SUCCESS,
            serializeSubmitSharesSuccess({
                channelId: submission.channelId,
                lastSequenceNumber: submission.sequenceNumber,
                newSubmitsAcceptedCount: 1,
                newSharesSum: BigInt(Math.round(jobDifficulty)),
            }),
            SV2_CHANNEL_MSG_FLAG,
        );

        channel.acceptedShareCount++;
        await this.handleAcceptedShare(submission, channel, job, jobTemplate, submissionDifficulty, jobDifficulty);
    }

    private async handleSubmitSharesExtended(payload: Buffer): Promise<void> {
        const submission = deserializeSubmitSharesExtended(new BufferReader(payload));
        const channel = this.channels.get(submission.channelId);
        if (channel == null || channel.channelType !== 'extended') {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'invalid-channel-id');
            return;
        }

        const submissionKey = [
            submission.jobId,
            submission.nonce,
            submission.ntime,
            submission.version,
            submission.extranonce.toString('hex'),
        ].join(':');
        if (channel.miningSubmissionHashes.has(submissionKey)) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'stale-share');
            return;
        }
        channel.miningSubmissionHashes.add(submissionKey);
        if (channel.miningSubmissionHashes.size > 10000) {
            channel.miningSubmissionHashes.clear();
        }

        const extendedJob = channel.extendedJobs.get(submission.jobId);
        const jobDifficulty = channel.jobIdToDifficulty.get(submission.jobId) ?? channel.sessionDifficulty;
        if (extendedJob == null) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'invalid-job-id');
            return;
        }
        if (extendedJob.retiredAt != null) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'stale-share');
            return;
        }
        if (submission.extranonce.length !== channel.extranonceSize) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'invalid-extranonce-size');
            return;
        }

        const coinbaseTxBytes = Buffer.concat([
            extendedJob.coinbasePrefix,
            channel.extranoncePrefix,
            submission.extranonce,
            extendedJob.coinbaseSuffix,
        ]);
        let merkleRoot = bitcoinjs.crypto.hash256(coinbaseTxBytes);
        const merklePair = Buffer.alloc(64);
        for (const sibling of extendedJob.merklePath) {
            merklePair.set(merkleRoot, 0);
            merklePair.set(sibling, 32);
            merkleRoot = bitcoinjs.crypto.hash256(merklePair);
        }

        const header = this.buildHeader(
            {
                ...extendedJob.jobTemplate,
                block: Object.assign(new bitcoinjs.Block(), extendedJob.jobTemplate.block, {
                    prevHash: extendedJob.prevHash,
                    bits: extendedJob.nBits,
                }),
            },
            merkleRoot,
            submission.version,
            submission.ntime,
            submission.nonce,
        );
        const { submissionDifficulty, hashBuffer } = DifficultyUtils.calculateDifficulty(header);
        const target = DifficultyUtils.difficultyToTarget(jobDifficulty);

        if (!DifficultyUtils.meetsTarget(hashBuffer, target)) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'difficulty-too-low');
            return;
        }

        await this.sendFrame(
            Sv2MsgType.SUBMIT_SHARES_SUCCESS,
            serializeSubmitSharesSuccess({
                channelId: submission.channelId,
                lastSequenceNumber: submission.sequenceNumber,
                newSubmitsAcceptedCount: 1,
                newSharesSum: BigInt(Math.round(jobDifficulty)),
            }),
            SV2_CHANNEL_MSG_FLAG,
        );

        channel.acceptedShareCount++;
        let updatedJobBlock: bitcoinjs.Block = null;
        if (submissionDifficulty >= extendedJob.jobTemplate.blockData.networkDifficulty) {
            updatedJobBlock = this.reconstructExtendedBlock(extendedJob, submission, merkleRoot, channel.extranoncePrefix);
        }
        await this.recordAcceptedShare(submissionDifficulty, jobDifficulty, extendedJob.jobTemplate, updatedJobBlock);
    }

    private async handleAcceptedShare(
        submission: { nonce: number; ntime: number; version: number },
        channel: ChannelState,
        job: MiningJob,
        jobTemplate: IJobTemplate,
        submissionDifficulty: number,
        jobDifficulty: number,
    ): Promise<void> {
        let updatedJobBlock: bitcoinjs.Block = null;
        if (submissionDifficulty >= jobTemplate.blockData.networkDifficulty) {
            const versionMask = submission.version ^ jobTemplate.block.version;
            updatedJobBlock = job.copyAndUpdateBlock(
                jobTemplate,
                versionMask,
                submission.nonce,
                channel.extranoncePrefix.toString('hex'),
                FIXED_STANDARD_EXTRANONCE2,
                submission.ntime,
            );
        }

        await this.recordAcceptedShare(submissionDifficulty, jobDifficulty, jobTemplate, updatedJobBlock);
    }

    private async recordAcceptedShare(
        submissionDifficulty: number,
        jobDifficulty: number,
        jobTemplate: IJobTemplate,
        updatedJobBlock: bitcoinjs.Block | null,
    ): Promise<void> {
        await this.ensureClientEntity();

        if (updatedJobBlock != null) {
            console.log(`[SV2 ${this.sessionId}] BLOCK FOUND at height ${jobTemplate.blockData.height}`);
            const blockHex = updatedJobBlock.toHex(false);
            const result = await this.bitcoinRpcService.SUBMIT_BLOCK(blockHex);
            await this.blocksService.save({
                height: jobTemplate.blockData.height,
                minerAddress: this.address,
                worker: this.workerName,
                sessionId: this.sessionId,
                blockData: blockHex,
            });
            await this.notificationService.notifySubscribersBlockFound(
                this.address,
                jobTemplate.blockData.height,
                updatedJobBlock,
                result,
            );
            if (result == null) {
                await this.addressSettingsService.resetBestDifficultyAndShares();
            }
        }

        await this.statistics.addShares(this.clientEntity, jobDifficulty);
        const now = new Date();
        this.clientService.heartbeatBulkAsync(this.clientEntity.id, this.statistics.hashRate, now);
        this.clientEntity.updatedAt = now;

        if (submissionDifficulty > this.clientEntity.bestDifficulty) {
            await this.clientService.updateBestDifficultyIfHigher(this.clientEntity.id, submissionDifficulty);
            this.clientEntity.bestDifficulty = submissionDifficulty;
            await this.addressSettingsService.updateBestDifficultyIfHigher(
                this.address,
                submissionDifficulty,
                this.userAgent,
            );
        }
    }

    private reconstructExtendedBlock(
        extendedJob: ExtendedJobData,
        submission: Sv2SubmitSharesExtended,
        merkleRoot: Buffer,
        extranoncePrefix: Buffer,
    ): bitcoinjs.Block {
        const jobTemplate = extendedJob.jobTemplate;
        const testBlock = Object.assign(new bitcoinjs.Block(), jobTemplate.block);
        testBlock.transactions = jobTemplate.block.transactions.map(tx => Object.assign(new bitcoinjs.Transaction(), tx));

        const coinbaseTx = extendedJob.miningJob.cloneCoinbaseTransaction();
        const script = coinbaseTx.ins[0].script;
        coinbaseTx.ins[0].script = Buffer.concat([
            script.subarray(0, script.length - TOTAL_EXTRANONCE_SIZE_BYTES),
            extranoncePrefix,
            submission.extranonce,
        ]);
        testBlock.transactions[0] = coinbaseTx;
        testBlock.version = submission.version;
        testBlock.nonce = submission.nonce;
        testBlock.timestamp = submission.ntime;
        testBlock.merkleRoot = merkleRoot;
        return testBlock;
    }

    private async handleUpdateChannel(payload: Buffer): Promise<void> {
        const message = deserializeUpdateChannel(new BufferReader(payload));
        const channel = this.channels.get(message.channelId);
        if (channel == null) {
            return;
        }

        channel.declaredMaxTarget = Buffer.from(message.maximumTarget);
        if (Number.isFinite(message.nominalHashRate) && message.nominalHashRate > 0) {
            const nextDifficulty = DifficultyUtils.hashRateToDifficulty(
                message.nominalHashRate,
                this.targetSharesPerMinute,
            );
            if (Number.isFinite(nextDifficulty) && nextDifficulty > 0) {
                channel.sessionDifficulty = DifficultyUtils.clampDifficultyToMaxTarget(
                    nextDifficulty,
                    channel.declaredMaxTarget,
                );
                await this.sendSetTarget(channel);
            }
        }
    }

    private handleCloseChannel(payload: Buffer): void {
        const message = deserializeCloseChannel(new BufferReader(payload));
        const channel = this.channels.get(message.channelId);
        if (channel?.channelType === 'extended') {
            this.stratumV2Service.releaseExtendedExtranoncePrefix(message.channelId);
        }
        this.channels.delete(message.channelId);
        if (this.primaryChannelId === message.channelId) {
            this.primaryChannelId = this.channels.keys().next().value ?? null;
        }
        if (this.channels.size === 0) {
            this.closeSocket();
        }
    }

    private subscribeToJobs(): void {
        if (this.stratumSubscription != null) {
            return;
        }

        this.stratumSubscription = this.stratumV1JobsService.newMiningJob$.subscribe({
            next: async (jobTemplate) => {
                try {
                    if (jobTemplate.blockData.clearJobs) {
                        this.channels.forEach(channel => {
                            if (channel.channelType === 'extended') {
                                const now = Date.now();
                                channel.extendedJobs.forEach(job => {
                                    if (job.retiredAt == null) {
                                        job.retiredAt = now;
                                    }
                                });
                                this.cleanupRetiredExtendedJobs(channel);
                            } else {
                                channel.jobIdToDifficulty.clear();
                                channel.jobIdToMerkleRoot.clear();
                            }
                            channel.miningSubmissionHashes.clear();
                        });
                    }
                    for (const channel of this.channels.values()) {
                        if (channel.channelType === 'extended') {
                            await this.sendNewExtendedMiningJob(channel, jobTemplate, jobTemplate.blockData.clearJobs);
                        } else {
                            await this.sendNewMiningJob(channel, jobTemplate, jobTemplate.blockData.clearJobs);
                        }
                    }
                } catch (error) {
                    console.error(`[SV2 ${this.sessionId}] Failed to send mining job: ${error.message}`);
                    this.closeSocket();
                }
            },
            error: error => {
                console.error(`[SV2 ${this.sessionId}] Job subscription failed: ${error.message}`);
                this.closeSocket();
            },
        });
    }

    private startDifficultyTimer(): void {
        if (this.difficultyTimer != null) {
            return;
        }

        this.difficultyTimer = setInterval(() => {
            void this.checkDifficulty();
        }, this.difficultyCheckIntervalMs);
    }

    private async checkDifficulty(): Promise<void> {
        const targetDiff = this.statistics.getSuggestedDifficulty(this.sessionDifficulty);
        if (targetDiff == null || targetDiff === this.sessionDifficulty || !Number.isFinite(targetDiff)) {
            return;
        }

        this.sessionDifficulty = targetDiff;
        for (const channel of this.channels.values()) {
            channel.sessionDifficulty = DifficultyUtils.clampDifficultyToMaxTarget(
                targetDiff,
                channel.declaredMaxTarget,
            );
            await this.sendSetTarget(channel);
        }

        const jobTemplate = await firstValueFrom(this.stratumV1JobsService.newMiningJob$);
        const refreshedTemplate: IJobTemplate = {
            ...jobTemplate,
            block: Object.assign(new bitcoinjs.Block(), jobTemplate.block, {
                timestamp: Math.max(jobTemplate.block.timestamp, Math.floor(Date.now() / 1000)),
            }),
            blockData: { ...jobTemplate.blockData, clearJobs: true },
        };
        for (const channel of this.channels.values()) {
            if (channel.channelType === 'extended') {
                await this.sendNewExtendedMiningJob(channel, refreshedTemplate, true);
            } else {
                await this.sendNewMiningJob(channel, refreshedTemplate, true);
            }
        }
    }

    private async sendNewMiningJob(channel: ChannelState, jobTemplate: IJobTemplate, sendPrevHash: boolean): Promise<void> {
        if (this.address == null) {
            return;
        }

        const jobIdHex = this.stratumV1JobsService.getNextId();
        const jobId = parseInt(jobIdHex, 16);
        const job = new MiningJob(
            this.network,
            jobIdHex,
            [{ address: this.address, percent: 100 }],
            jobTemplate,
        );
        this.stratumV1JobsService.addJob(job);

        const jobSideBlock = job.copyAndUpdateBlock(
            jobTemplate,
            0,
            0,
            channel.extranoncePrefix.toString('hex'),
            FIXED_STANDARD_EXTRANONCE2,
            jobTemplate.block.timestamp,
        );
        const merkleRoot = Buffer.from(jobSideBlock.merkleRoot);
        channel.jobIdToDifficulty.set(jobId, channel.sessionDifficulty);
        channel.jobIdToMerkleRoot.set(jobId, merkleRoot);

        await this.sendFrame(
            Sv2MsgType.NEW_MINING_JOB,
            serializeNewMiningJob({
                channelId: channel.channelId,
                jobId,
                minNtime: sendPrevHash ? null : jobTemplate.block.timestamp,
                version: jobTemplate.block.version,
                merkleRoot,
            }),
            SV2_CHANNEL_MSG_FLAG,
        );

        if (sendPrevHash) {
            await this.sendFrame(
                Sv2MsgType.SET_NEW_PREV_HASH,
                serializeSetNewPrevHash({
                    channelId: channel.channelId,
                    jobId,
                    prevHash: Buffer.from(jobTemplate.block.prevHash),
                    minNtime: jobTemplate.block.timestamp,
                    nBits: jobTemplate.block.bits,
                }),
                SV2_CHANNEL_MSG_FLAG,
            );
        }
    }

    private async sendNewExtendedMiningJob(channel: ChannelState, jobTemplate: IJobTemplate, sendPrevHash: boolean): Promise<void> {
        if (this.address == null) {
            return;
        }

        const jobIdHex = this.stratumV1JobsService.getNextId();
        const jobId = parseInt(jobIdHex, 16);
        const job = new MiningJob(
            this.network,
            jobIdHex,
            [{ address: this.address, percent: 100 }],
            jobTemplate,
        );
        this.stratumV1JobsService.addJob(job);

        const merklePath = jobTemplate.merkle_branch.map(branch => Buffer.from(branch, 'hex'));
        const totalExtranonceSize = channel.extranoncePrefix.length + channel.extranonceSize;
        const coinbasePrefix = patchCoinbasePrefixVarint(job.getCoinbasePrefixBuffer(), totalExtranonceSize);
        const coinbaseSuffix = job.getCoinbaseSuffixBuffer();

        await this.sendFrame(
            Sv2MsgType.NEW_EXTENDED_MINING_JOB,
            serializeNewExtendedMiningJob({
                channelId: channel.channelId,
                jobId,
                minNtime: sendPrevHash ? null : jobTemplate.block.timestamp,
                version: jobTemplate.block.version,
                versionRollingAllowed: true,
                merklePath,
                coinbasePrefix,
                coinbaseSuffix,
            }),
            SV2_CHANNEL_MSG_FLAG,
        );

        const prevHash = sendPrevHash
            ? Buffer.from(jobTemplate.block.prevHash)
            : Buffer.from(channel.latestExtendedPrevHash);
        const nBits = sendPrevHash ? jobTemplate.block.bits : channel.latestExtendedNBits;
        const minNtime = sendPrevHash ? jobTemplate.block.timestamp : channel.latestExtendedMinNtime;

        channel.jobIdToDifficulty.set(jobId, channel.sessionDifficulty);
        channel.extendedJobs.set(jobId, {
            coinbasePrefix,
            coinbaseSuffix,
            merklePath,
            prevHash,
            nBits,
            minNtime,
            jobTemplate,
            miningJob: job,
            creation: Date.now(),
        });

        if (sendPrevHash) {
            channel.latestExtendedPrevHash = prevHash;
            channel.latestExtendedNBits = nBits;
            channel.latestExtendedMinNtime = minNtime;
            await this.sendFrame(
                Sv2MsgType.SET_NEW_PREV_HASH,
                serializeSetNewPrevHash({
                    channelId: channel.channelId,
                    jobId,
                    prevHash,
                    minNtime,
                    nBits,
                }),
                SV2_CHANNEL_MSG_FLAG,
            );
        }
    }

    private cleanupRetiredExtendedJobs(channel: ChannelState): void {
        const cutoff = Date.now() - RETIRED_EXTENDED_JOB_RETENTION_MS;
        for (const [jobId, job] of channel.extendedJobs.entries()) {
            if (job.retiredAt != null && job.retiredAt < cutoff) {
                channel.extendedJobs.delete(jobId);
                channel.jobIdToDifficulty.delete(jobId);
            }
        }
    }

    private buildHeader(
        jobTemplate: IJobTemplate,
        merkleRoot: Buffer,
        version: number,
        timestamp: number,
        nonce: number,
    ): Buffer {
        const header = Buffer.alloc(80);
        header.writeInt32LE(version, 0);
        jobTemplate.block.prevHash.copy(header, 4);
        merkleRoot.copy(header, 36);
        header.writeUInt32LE(timestamp >>> 0, 68);
        header.writeUInt32LE(jobTemplate.block.bits >>> 0, 72);
        header.writeUInt32LE(nonce >>> 0, 76);
        return header;
    }

    private async sendSetTarget(channel: ChannelState): Promise<void> {
        await this.sendFrame(
            Sv2MsgType.SET_TARGET,
            serializeSetTarget({
                channelId: channel.channelId,
                maxTarget: DifficultyUtils.difficultyToTarget(channel.sessionDifficulty),
            }),
            SV2_CHANNEL_MSG_FLAG,
        );
    }

    private async sendOpenChannelError(requestId: number, errorCode: string): Promise<void> {
        await this.sendFrame(
            Sv2MsgType.OPEN_STANDARD_MINING_CHANNEL_ERROR,
            serializeOpenMiningChannelError({ requestId, errorCode }),
        );
    }

    private async sendShareError(channelId: number, sequenceNumber: number, errorCode: string): Promise<void> {
        await this.sendFrame(
            Sv2MsgType.SUBMIT_SHARES_ERROR,
            serializeSubmitSharesError({
                channelId,
                sequenceNumber,
                errorCode,
            }),
            SV2_CHANNEL_MSG_FLAG,
        );
    }

    private async sendFrame(msgType: number, payload: Buffer, extensionType = 0): Promise<void> {
        const data = this.frameWriter.writeFrame({
            extensionType,
            msgType,
            msgLength: payload.length,
        }, payload);
        await this.writeRaw(data);
    }

    private async writeRaw(data: Buffer): Promise<void> {
        if (this.socket.destroyed || this.socket.writableEnded) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            this.socket.write(data, error => error ? reject(error) : resolve());
        });
    }

    private async ensureClientEntity(): Promise<void> {
        if (this.clientEntity != null) {
            return;
        }

        if (this.creatingEntity == null) {
            this.creatingEntity = (async () => {
                this.clientEntity = await this.clientService.insert({
                    sessionId: this.sessionId,
                    address: this.address,
                    clientName: this.workerName,
                    userAgent: this.userAgent,
                    startTime: new Date(),
                    bestDifficulty: 0,
                });
            })();
        }

        await this.creatingEntity;
    }

    private parseUserIdentity(userIdentity: string): { address: string; workerName: string } {
        const parts = userIdentity.split('.');
        const rawAddress = parts[0] ?? '';
        return {
            address: this.normalizeAddress(rawAddress),
            workerName: parts.length > 1 ? parts.slice(1).join('.') : 'default',
        };
    }

    private normalizeAddress(address: string): string {
        if (
            address.startsWith('bc1')
            || address.startsWith('BC1')
            || address.startsWith('tb1')
            || address.startsWith('TB1')
            || address.startsWith('bcrt1')
            || address.startsWith('BCRT1')
        ) {
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

    private getInitialDifficulty(): number {
        const configured = parseFloat(
            this.configService.get<string>('SV2_START_DIFFICULTY')
            ?? this.configService.get<string>('STRATUM_START_DIFFICULTY')
            ?? '',
        );
        return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_START_DIFFICULTY;
    }

    private getTargetSharesPerMinute(): number {
        const configured = parseFloat(this.configService.get<string>('SV2_TARGET_SHARES_PER_MINUTE') ?? '');
        return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TARGET_SHARES_PER_MINUTE;
    }

    private getDifficultyCheckIntervalMs(): number {
        const configured = parseInt(this.configService.get<string>('SV2_DIFFICULTY_CHECK_INTERVAL_MS') ?? '', 10);
        return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DIFFICULTY_CHECK_INTERVAL_MS;
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

    private logProtocolError(error: Error): void {
        if (!this.isNoisyAuthFailure(error)) {
            console.error(`[SV2 ${this.sessionId}] ${error.message}`);
            return;
        }

        const remote = this.socket.remoteAddress ?? 'unknown';
        const key = `${remote}:${error.message}`;
        const now = Date.now();
        const logState = StratumV2Client.authFailureLogState.get(key);
        if (logState != null && now < logState.nextLogAt) {
            logState.suppressed += 1;
            return;
        }

        const suppressed = logState?.suppressed ?? 0;
        const suffix = suppressed > 0 ? ` (${suppressed} similar auth failures suppressed)` : '';
        console.warn(`[SV2 ${this.sessionId}] Authentication failed from ${remote}: ${error.message}; firstChunk=${this.firstChunkSummary}${suffix}`);
        StratumV2Client.authFailureLogState.set(key, {
            nextLogAt: now + SV2_AUTH_FAILURE_LOG_INTERVAL_MS,
            suppressed: 0,
        });
    }

    private isNoisyAuthFailure(error: Error): boolean {
        return error.message.includes('Unsupported state or unable to authenticate data');
    }

    private describeChunk(chunk: Buffer): string {
        const preview = chunk.subarray(0, 16);
        const printable = Array.from(preview).every(byte => byte >= 0x20 && byte <= 0x7e);
        const prefix = printable
            ? preview.toString('ascii').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
            : preview.toString('hex');
        return `len=${chunk.length},${printable ? 'ascii' : 'hex'}=${prefix}`;
    }

    private closeSocket(): void {
        if (!this.socket.destroyed) {
            this.socket.destroy();
        }
        void this.destroy();
    }
}
