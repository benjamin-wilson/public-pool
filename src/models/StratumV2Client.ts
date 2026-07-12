import { ConfigService } from '@nestjs/config';
import { getAddressInfo } from 'bitcoin-address-validation';
import * as bitcoinjs from 'bitcoinjs-lib';
import * as crypto from 'crypto';
import { Socket } from 'net';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ClientService } from '../ORM/client/client.service';
import { PayoutSnapshotService } from '../ORM/payout-snapshot/payout-snapshot.service';
import { ShareAccountingService } from '../ORM/share-accounting/share-accounting.service';
import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { CustomWorkService } from '../services/custom-work.service';
import { NotificationService } from '../services/notification.service';
import { RedisMessagingService } from '../services/redis-messaging.service';
import { StratumV2Service } from '../services/stratum-v2.service';
import { IJobTemplate, StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import {
    BitcoinNetworkName,
    calculateBlockSubsidySats,
    EMPTY_WITNESS_COMMITMENT_HASH,
} from '../services/subsidy-only-template.factory';
import { Sv2JobDeclarationRegistryService } from '../services/sv2-job-declaration-registry.service';
import { patchCoinbasePrefixVarint } from '../utils/coinbase-prefix.utils';
import { DifficultyUtils } from '../utils/difficulty.utils';
import { hash256 } from '../utils/hash.utils';
import { AddressObject, MiningJob } from './MiningJob';
import { StratumV1ClientStatistics } from './StratumV1ClientStatistics';
import { PayoutMode } from '../types/payout-mode';
import { IBlockTemplate } from './bitcoin-rpc/IBlockTemplate';
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
import {
    deserializeSetCustomMiningJob,
    serializeSetCustomMiningJobError,
    serializeSetCustomMiningJobSuccess,
} from './sv2/sv2-jdp-messages';

const DEFAULT_START_DIFFICULTY = 100000;
const DEFAULT_MIN_DIFFICULTY = 0.001;
const DEFAULT_TARGET_SHARES_PER_MINUTE = 2;
const DEFAULT_DIFFICULTY_CHECK_INTERVAL_MS = 60 * 1000;
const DEFAULT_CLIENT_HASHRATE_PERSIST_INTERVAL_MS = 60 * 1000;
const FIXED_STANDARD_EXTRANONCE2 = '0000000000000000';
const DEFAULT_SV2_JOB_RETENTION_MS = 5 * 60 * 1000;
const DEFAULT_SV2_MAX_RETAINED_JOBS_PER_CHANNEL = 16;
const DEFAULT_SV2_MAX_QUEUED_JOB_OPERATIONS = 4;
const DEFAULT_SV2_MAX_SOCKET_BUFFER_BYTES = 256 * 1024;
const DEFAULT_SV2_SOCKET_WRITE_TIMEOUT_MS = 2 * 1000;
const SV2_AUTH_FAILURE_LOG_INTERVAL_MS = 60 * 1000;
const BIP320_CONSENSUS_VERSION_MASK = 0xe0001fff;

type Sv2JobOperationKind = 'canonical' | 'activation' | 'ordered';

interface QueuedSv2JobOperation {
    kind: Sv2JobOperationKind;
    operation: () => Promise<void>;
    resolve: () => void;
    tipKey?: string;
}

interface Sv2HeaderContext {
    tipKey: string;
    prevHash: Buffer;
    nBits: number;
    minNtime: number;
    height: number;
    networkDifficulty: number;
    baseVersion: number;
    requiredVersionBits: number;
    activationMinNtime?: number;
    activatedAtMonotonicNs?: bigint;
}

interface Sv2WorkActivation extends Sv2HeaderContext {
    version: number;
}

interface StandardJobData {
    merkleRoot: Buffer;
    jobTemplate: IJobTemplate;
    miningJob: MiningJob;
    expectedHeight: number;
    expectedVersion: number;
    headerContext?: Sv2HeaderContext;
    retiredAt?: number;
    creation: number;
}

interface ExtendedJobData {
    coinbasePrefix: Buffer;
    coinbaseSuffix: Buffer;
    merklePath: Buffer[];
    prevHash: Buffer;
    nBits: number;
    minNtime: number;
    jobTemplate: IJobTemplate;
    miningJob: MiningJob;
    expectedHeight: number;
    expectedVersion: number;
    headerContext?: Sv2HeaderContext;
    retiredAt?: number;
    creation: number;
    workProtocol?: 'pool' | 'sv2_jdp';
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
    standardJobs: Map<number, StandardJobData>;
    extendedJobs: Map<number, ExtendedJobData>;
    latestExtendedPrevHash: Buffer;
    latestExtendedNBits: number;
    latestExtendedMinNtime: number;
    miningSubmissionHashes: Set<string>;
    acceptedShareCount: number;
    readyForCanonicalJobs: boolean;
    lastCanonicalJobSignature?: string;
    stagedFutureJobId?: number;
    activeTipKey?: string;
    activatedFutureTipKey?: string;
    activePrevHashMinNtime?: number;
    activePrevHashAtMonotonicNs?: bigint;
    activePrevHashJobId?: number;
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
    private readonly jobRetentionMs: number;
    private readonly maxRetainedJobsPerChannel: number;
    private readonly maxQueuedJobOperations: number;
    private readonly maxSocketBufferBytes: number;
    private readonly socketWriteTimeoutMs: number;

    private handshakeBuffer = Buffer.alloc(0);
    private handshakeComplete = false;
    private processingHandshake = false;
    private destroyed = false;
    private jobOperationQueue: QueuedSv2JobOperation[] = [];
    private drainingJobOperations = false;
    private activeJobOperation: QueuedSv2JobOperation = null;
    private pendingSocketWriteBytes = 0;
    private futureTemplateCounter = 0;
    private nextMiningJobId = 1;
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
    private workSelectionEnabled = false;
    private versionRollingEnabled = false;
    private lastHashRatePersistedAt = 0;

    constructor(
        private readonly socket: Socket,
        firstChunk: Buffer,
        private readonly stratumV2Service: StratumV2Service,
        private readonly stratumV1JobsService: StratumV1JobsService,
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly clientService: ClientService,
        private readonly notificationService: NotificationService,
        private readonly blocksService: BlocksService,
        private readonly configService: ConfigService,
        private readonly addressSettingsService: AddressSettingsService,
        private readonly customWorkService: CustomWorkService,
        private readonly jobDeclarationRegistry: Sv2JobDeclarationRegistryService,
        private readonly shareAccountingService?: ShareAccountingService,
        private readonly redisMessagingService?: RedisMessagingService,
        private readonly payoutSnapshotService?: PayoutSnapshotService,
        private readonly payoutMode: PayoutMode = 'solo',
    ) {
        this.firstChunkSummary = this.describeChunk(firstChunk);
        this.noiseSession = new Sv2NoiseSession(this.stratumV2Service.getNoiseConfig());
        this.sessionDifficulty = this.getInitialDifficulty();
        this.targetSharesPerMinute = this.getTargetSharesPerMinute();
        this.difficultyCheckIntervalMs = this.getDifficultyCheckIntervalMs();
        this.jobRetentionMs = this.getPositiveIntegerConfig(
            'SV2_JOB_RETENTION_MS',
            this.getPositiveIntegerConfig('STRATUM_JOB_RETENTION_MS', DEFAULT_SV2_JOB_RETENTION_MS),
        );
        this.maxRetainedJobsPerChannel = this.getPositiveIntegerConfig(
            'SV2_MAX_RETAINED_JOBS_PER_CHANNEL',
            DEFAULT_SV2_MAX_RETAINED_JOBS_PER_CHANNEL,
        );
        this.maxQueuedJobOperations = this.getPositiveIntegerConfig(
            'SV2_MAX_QUEUED_JOB_OPERATIONS',
            DEFAULT_SV2_MAX_QUEUED_JOB_OPERATIONS,
        );
        this.maxSocketBufferBytes = this.getPositiveIntegerConfig(
            'SV2_MAX_SOCKET_BUFFER_BYTES',
            DEFAULT_SV2_MAX_SOCKET_BUFFER_BYTES,
        );
        this.socketWriteTimeoutMs = this.getPositiveIntegerConfig(
            'SV2_SOCKET_WRITE_TIMEOUT_MS',
            DEFAULT_SV2_SOCKET_WRITE_TIMEOUT_MS,
        );
        this.statistics = new StratumV1ClientStatistics(this.getMinimumDifficulty());
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
        this.settleQueuedJobOperations();
        this.stratumV2Service.unregisterClient?.(this);

        if (this.difficultyTimer != null) {
            clearInterval(this.difficultyTimer);
            this.difficultyTimer = null;
        }
        for (const channel of this.channels.values()) {
            this.stratumV2Service.releaseExtranoncePrefix(channel.channelId);
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
            case Sv2MsgType.SET_CUSTOM_MINING_JOB:
                await this.handleSetCustomMiningJob(payload);
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
            | Sv2MiningSetupFlags.REQUIRES_WORK_SELECTION
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
        this.versionRollingEnabled = versionRolling;
        this.workSelectionEnabled = (message.flags & Sv2MiningSetupFlags.REQUIRES_WORK_SELECTION) !== 0;
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
        const extranoncePrefix = this.stratumV2Service.generateExtranoncePrefix(channelId);
        let channelDifficulty = this.sessionDifficulty;
        if (Number.isFinite(message.nominalHashRate) && message.nominalHashRate > 0) {
            const calculatedDifficulty = DifficultyUtils.hashRateToDifficulty(
                message.nominalHashRate,
                this.targetSharesPerMinute,
            );
            if (Number.isFinite(calculatedDifficulty) && calculatedDifficulty > 0) {
                channelDifficulty = this.clampDifficulty(calculatedDifficulty);
            }
        }
        channelDifficulty = this.clampDifficulty(DifficultyUtils.clampDifficultyToMaxTarget(channelDifficulty, message.maxTarget));
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
            standardJobs: new Map(),
            extendedJobs: new Map(),
            latestExtendedPrevHash: Buffer.alloc(32),
            latestExtendedNBits: 0,
            latestExtendedMinNtime: 0,
            miningSubmissionHashes: new Set(),
            acceptedShareCount: 0,
            readyForCanonicalJobs: false,
        };
        this.channels.set(channelId, channel);
        if (this.primaryChannelId == null) {
            this.primaryChannelId = channelId;
        }

        await this.ensureClientEntity();
        this.disableApplicationIdleTimeout();
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
        channel.readyForCanonicalJobs = true;

        if (!this.workSelectionEnabled) {
            const jobTemplate = this.stratumV2Service.getLatestCanonicalJob(this.payoutMode);
            if (jobTemplate != null) {
                await this.enqueueCanonicalJob(jobTemplate);
                if (this.destroyed) {
                    return;
                }
            }
            const activationTemplate = this.stratumV2Service.getLatestWorkActivationTemplate?.();
            if (activationTemplate != null) {
                await this.enqueueWorkActivation(activationTemplate);
                if (this.destroyed) {
                    return;
                }
            }
        }

        if (isFirstChannel && !this.workSelectionEnabled) {
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
        const maxMinerExtranonceSize = Math.max(0, this.stratumV2Service.getExtendedTotalExtranonceSize() - extranoncePrefix.length);
        const defaultMinerExtranonceSize = Math.min(
            this.stratumV2Service.getExtendedMinerExtranonceSize(),
            maxMinerExtranonceSize,
        );
        const requestedMinerExtranonceSize = Math.max(0, message.minExtranonceSize);
        const extranonceSize = Math.max(defaultMinerExtranonceSize, requestedMinerExtranonceSize);
        if (extranonceSize > maxMinerExtranonceSize) {
            this.stratumV2Service.releaseExtendedExtranoncePrefix(channelId);
            await this.sendOpenChannelError(message.requestId, 'min-extranonce-size-too-large');
            return;
        }

        let channelDifficulty = this.sessionDifficulty;
        if (Number.isFinite(message.nominalHashRate) && message.nominalHashRate > 0) {
            const calculatedDifficulty = DifficultyUtils.hashRateToDifficulty(
                message.nominalHashRate,
                this.targetSharesPerMinute,
            );
            if (Number.isFinite(calculatedDifficulty) && calculatedDifficulty > 0) {
                channelDifficulty = this.clampDifficulty(calculatedDifficulty);
            }
        }
        channelDifficulty = this.clampDifficulty(DifficultyUtils.clampDifficultyToMaxTarget(channelDifficulty, message.maxTarget));
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
            standardJobs: new Map(),
            extendedJobs: new Map(),
            latestExtendedPrevHash: Buffer.alloc(32),
            latestExtendedNBits: 0,
            latestExtendedMinNtime: 0,
            miningSubmissionHashes: new Set(),
            acceptedShareCount: 0,
            readyForCanonicalJobs: false,
        };
        this.channels.set(channelId, channel);
        if (this.primaryChannelId == null) {
            this.primaryChannelId = channelId;
        }

        await this.ensureClientEntity();
        this.disableApplicationIdleTimeout();
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
        channel.readyForCanonicalJobs = true;

        if (!this.workSelectionEnabled) {
            const jobTemplate = this.stratumV2Service.getLatestCanonicalJob(this.payoutMode);
            if (jobTemplate != null) {
                await this.enqueueCanonicalJob(jobTemplate);
                if (this.destroyed) {
                    return;
                }
            }
            const activationTemplate = this.stratumV2Service.getLatestWorkActivationTemplate?.();
            if (activationTemplate != null) {
                await this.enqueueWorkActivation(activationTemplate);
                if (this.destroyed) {
                    return;
                }
            }
        }

        if (isFirstChannel && !this.workSelectionEnabled) {
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

        const standardJob = channel.standardJobs.get(submission.jobId);
        if (standardJob == null) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'invalid-job-id');
            return;
        }
        if (standardJob.headerContext == null) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'stale-share');
            return;
        }
        const headerContext = standardJob.headerContext;
        if (!this.isSubmissionHeaderValid(headerContext, submission.version, submission.ntime)) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'stale-share');
            return;
        }

        const header = this.buildHeader(
            headerContext,
            standardJob.merkleRoot,
            submission.version,
            submission.ntime,
            submission.nonce,
        );
        const { submissionDifficulty, hashBuffer } = DifficultyUtils.calculateDifficulty(header);
        const jobDifficulty = channel.jobIdToDifficulty.get(submission.jobId) ?? channel.sessionDifficulty;
        const target = DifficultyUtils.difficultyToTarget(jobDifficulty);
        const isBlockCandidate = DifficultyUtils.meetsCompactTarget(hashBuffer, headerContext.nBits);
        const meetsJobTarget = DifficultyUtils.meetsTarget(hashBuffer, target);
        const isStale = standardJob.retiredAt != null
            || headerContext.tipKey !== channel.activeTipKey;
        if (isStale) {
            if (!isBlockCandidate) {
                await this.sendShareError(submission.channelId, submission.sequenceNumber, 'stale-share');
                return;
            }

            const candidate = this.reconstructStandardBlock({
                jobTemplate: standardJob.jobTemplate,
                miningJob: standardJob.miningJob,
                headerContext,
            }, submission, channel.extranoncePrefix);
            const blockSubmissionResult = await this.submitBlockCandidate(
                standardJob.jobTemplate,
                candidate,
            );
            if (!this.isSuccessfulBlockSubmission(blockSubmissionResult)) {
                await this.sendShareError(submission.channelId, submission.sequenceNumber, 'stale-share');
                return;
            }

            const creditedDifficulty = this.getCreditedDifficulty(
                jobDifficulty,
                submissionDifficulty,
                meetsJobTarget,
            );
            await this.sendShareSuccess(
                submission.channelId,
                submission.sequenceNumber,
                creditedDifficulty,
            );
            channel.acceptedShareCount++;
            await this.recordAcceptedShare(
                submissionDifficulty,
                creditedDifficulty,
                standardJob.jobTemplate,
                null,
                {
                    jobId: standardJob.miningJob.jobId,
                    nonce: submission.nonce,
                    ntime: submission.ntime,
                    version: submission.version,
                    extraNonce2: FIXED_STANDARD_EXTRANONCE2,
                },
                {
                    blockCandidateResult: blockSubmissionResult,
                    isBlockCandidate: true,
                },
            );
            return;
        }

        if (!isBlockCandidate && !meetsJobTarget) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'difficulty-too-low');
            return;
        }
        const creditedDifficulty = this.getCreditedDifficulty(
            jobDifficulty,
            submissionDifficulty,
            meetsJobTarget,
        );

        await this.sendShareSuccess(
            submission.channelId,
            submission.sequenceNumber,
            creditedDifficulty,
        );

        channel.acceptedShareCount++;
        await this.handleAcceptedShare(
            submission,
            channel,
            standardJob.miningJob,
            standardJob.jobTemplate,
            submissionDifficulty,
            creditedDifficulty,
            hashBuffer,
            headerContext,
            isBlockCandidate,
        );
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
        if (submission.extranonce.length !== channel.extranonceSize) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'invalid-extranonce-size');
            return;
        }
        if (extendedJob.headerContext == null) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'stale-share');
            return;
        }
        if (!this.isSubmissionHeaderValid(extendedJob.headerContext, submission.version, submission.ntime)) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'stale-share');
            return;
        }

        const coinbaseTxBytes = Buffer.concat([
            extendedJob.coinbasePrefix,
            channel.extranoncePrefix,
            submission.extranonce,
            extendedJob.coinbaseSuffix,
        ]);
        let merkleRoot = hash256(coinbaseTxBytes);
        const merklePair = Buffer.alloc(64);
        for (const sibling of extendedJob.merklePath) {
            merklePair.set(merkleRoot, 0);
            merklePair.set(sibling, 32);
            merkleRoot = hash256(merklePair);
        }

        const header = this.buildHeader(
            extendedJob.headerContext,
            merkleRoot,
            submission.version,
            submission.ntime,
            submission.nonce,
        );
        const { submissionDifficulty, hashBuffer } = DifficultyUtils.calculateDifficulty(header);
        const isStale = extendedJob.retiredAt != null
            || (extendedJob.workProtocol !== 'sv2_jdp'
                && extendedJob.headerContext.tipKey !== channel.activeTipKey);
        if (isStale) {
            const isBlockCandidate = extendedJob.workProtocol !== 'sv2_jdp'
                && DifficultyUtils.meetsCompactTarget(hashBuffer, extendedJob.headerContext.nBits);
            if (!isBlockCandidate) {
                await this.sendShareError(submission.channelId, submission.sequenceNumber, 'stale-share');
                return;
            }

            const target = DifficultyUtils.difficultyToTarget(jobDifficulty);
            const meetsJobTarget = DifficultyUtils.meetsTarget(hashBuffer, target);
            const candidate = this.reconstructExtendedBlock(
                extendedJob,
                submission,
                merkleRoot,
                channel.extranoncePrefix,
            );
            const blockSubmissionResult = await this.submitBlockCandidate(
                extendedJob.jobTemplate,
                candidate,
            );
            if (!this.isSuccessfulBlockSubmission(blockSubmissionResult)) {
                await this.sendShareError(submission.channelId, submission.sequenceNumber, 'stale-share');
                return;
            }

            const creditedDifficulty = this.getCreditedDifficulty(
                jobDifficulty,
                submissionDifficulty,
                meetsJobTarget,
            );
            await this.sendShareSuccess(
                submission.channelId,
                submission.sequenceNumber,
                creditedDifficulty,
            );
            channel.acceptedShareCount++;
            await this.recordAcceptedShare(
                submissionDifficulty,
                creditedDifficulty,
                extendedJob.jobTemplate,
                null,
                {
                    jobId: submission.jobId.toString(16),
                    nonce: submission.nonce,
                    ntime: submission.ntime,
                    version: submission.version,
                    extraNonce2: submission.extranonce.toString('hex'),
                },
                {
                    workProtocol: 'pool',
                    blockCandidateResult: blockSubmissionResult,
                    isBlockCandidate: true,
                },
            );
            return;
        }
        const target = DifficultyUtils.difficultyToTarget(jobDifficulty);
        const isBlockCandidate = DifficultyUtils.meetsCompactTarget(
            hashBuffer,
            extendedJob.headerContext.nBits,
        );
        // Pool jobs bind nBits to the canonical template. A work-selection
        // client supplies its own nBits and submits its solution through JDP,
        // so that untrusted value must not bypass this channel's share target.
        const canBypassJobTarget = extendedJob.workProtocol !== 'sv2_jdp' && isBlockCandidate;
        const meetsJobTarget = DifficultyUtils.meetsTarget(hashBuffer, target);

        if (!canBypassJobTarget && !meetsJobTarget) {
            await this.sendShareError(submission.channelId, submission.sequenceNumber, 'difficulty-too-low');
            return;
        }
        const creditedDifficulty = this.getCreditedDifficulty(
            jobDifficulty,
            submissionDifficulty,
            meetsJobTarget,
        );

        await this.sendShareSuccess(
            submission.channelId,
            submission.sequenceNumber,
            creditedDifficulty,
        );

        channel.acceptedShareCount++;
        let updatedJobBlock: bitcoinjs.Block = null;
        let blockCandidateResult: string | null = null;
        if (isBlockCandidate) {
            if (extendedJob.workProtocol === 'sv2_jdp') {
                blockCandidateResult = 'sv2-jdp-client-submit-expected';
            } else {
                updatedJobBlock = this.reconstructExtendedBlock(extendedJob, submission, merkleRoot, channel.extranoncePrefix);
            }
        }
        await this.recordAcceptedShare(submissionDifficulty, creditedDifficulty, extendedJob.jobTemplate, updatedJobBlock, {
            jobId: submission.jobId.toString(16),
            nonce: submission.nonce,
            ntime: submission.ntime,
            version: submission.version,
            extraNonce2: submission.extranonce.toString('hex'),
        }, {
            workProtocol: extendedJob.workProtocol ?? 'pool',
            blockCandidateResult,
        });
    }

    private async handleSetCustomMiningJob(payload: Buffer): Promise<void> {
        const msg = deserializeSetCustomMiningJob(new BufferReader(payload));
        if (!this.workSelectionEnabled) {
            await this.sendFrame(
                Sv2MsgType.SET_CUSTOM_MINING_JOB_ERROR,
                serializeSetCustomMiningJobError({
                    channelId: msg.channelId,
                    requestId: msg.requestId,
                    errorCode: 'work-selection-not-negotiated',
                }),
            );
            return;
        }
        const channel = this.channels.get(msg.channelId);
        if (channel == null) {
            await this.sendFrame(
                Sv2MsgType.SET_CUSTOM_MINING_JOB_ERROR,
                serializeSetCustomMiningJobError({
                    channelId: msg.channelId,
                    requestId: msg.requestId,
                    errorCode: 'invalid-channel-id',
                }),
            );
            return;
        }
        if (channel.channelType !== 'extended') {
            await this.sendFrame(
                Sv2MsgType.SET_CUSTOM_MINING_JOB_ERROR,
                serializeSetCustomMiningJobError({
                    channelId: msg.channelId,
                    requestId: msg.requestId,
                    errorCode: 'invalid-channel-type',
                }),
            );
            return;
        }
        const declaredJob = this.jobDeclarationRegistry?.getDeclaredJob(msg.token);
        if (declaredJob == null || declaredJob.validationMode !== 'full_template') {
            await this.sendFrame(
                Sv2MsgType.SET_CUSTOM_MINING_JOB_ERROR,
                serializeSetCustomMiningJobError({
                    channelId: msg.channelId,
                    requestId: msg.requestId,
                    errorCode: 'invalid-mining-job-token',
                }),
            );
            return;
        }
        if (declaredJob.job.version !== msg.version) {
            await this.sendFrame(
                Sv2MsgType.SET_CUSTOM_MINING_JOB_ERROR,
                serializeSetCustomMiningJobError({
                    channelId: msg.channelId,
                    requestId: msg.requestId,
                    errorCode: 'declared-job-mismatch',
                }),
            );
            return;
        }

        const latestTemplate = this.stratumV2Service.getLatestCanonicalJob(this.payoutMode);
        if (latestTemplate == null) {
            await this.sendFrame(
                Sv2MsgType.SET_CUSTOM_MINING_JOB_ERROR,
                serializeSetCustomMiningJobError({
                    channelId: msg.channelId,
                    requestId: msg.requestId,
                    errorCode: 'template-not-found',
                }),
            );
            return;
        }
        const payoutInformation = this.getPayoutInformation(latestTemplate, this.address);
        if (payoutInformation == null) {
            await this.sendFrame(
                Sv2MsgType.SET_CUSTOM_MINING_JOB_ERROR,
                serializeSetCustomMiningJobError({
                    channelId: msg.channelId,
                    requestId: msg.requestId,
                    errorCode: 'template-not-found',
                }),
            );
            return;
        }
        const { jobId, jobIdHex } = this.allocateMiningJobId();
        const split = this.customWorkService.buildSv2CoinbaseSplit(
            msg,
            channel.extranoncePrefix.length + channel.extranonceSize,
        );
        const payoutValidation = this.validateCoinbasePayoutOutputs(
            Buffer.concat([
                split.coinbasePrefix,
                Buffer.alloc(channel.extranoncePrefix.length + channel.extranonceSize),
                split.coinbaseSuffix,
            ]),
            latestTemplate,
            payoutInformation,
        );
        if (!payoutValidation.valid) {
            await this.sendFrame(
                Sv2MsgType.SET_CUSTOM_MINING_JOB_ERROR,
                serializeSetCustomMiningJobError({
                    channelId: msg.channelId,
                    requestId: msg.requestId,
                    errorCode: payoutValidation.errorCode,
                }),
            );
            return;
        }
        const placeholderJob = new MiningJob(
            this.network,
            jobIdHex,
            payoutInformation,
            latestTemplate,
        );
        const activatedAtMonotonicNs = process.hrtime.bigint();
        channel.jobIdToDifficulty.set(jobId, channel.sessionDifficulty);
        channel.extendedJobs.set(jobId, {
            coinbasePrefix: split.coinbasePrefix,
            coinbaseSuffix: split.coinbaseSuffix,
            merklePath: msg.merklePath.map(branch => Buffer.from(branch)),
            prevHash: Buffer.from(msg.prevHash),
            nBits: msg.nBits,
            minNtime: msg.minNtime,
            jobTemplate: {
                ...latestTemplate,
                block: Object.assign(new bitcoinjs.Block(), latestTemplate.block, {
                    prevHash: Buffer.from(msg.prevHash),
                    bits: msg.nBits,
                    version: msg.version,
                    timestamp: msg.minNtime,
                }),
            },
            miningJob: placeholderJob,
            expectedHeight: latestTemplate.blockData.height,
            expectedVersion: msg.version,
            headerContext: {
                tipKey: `sv2-jdp:${msg.prevHash.toString('hex')}`,
                prevHash: Buffer.from(msg.prevHash),
                nBits: msg.nBits,
                minNtime: msg.minNtime,
                height: latestTemplate.blockData.height,
                networkDifficulty: DifficultyUtils.targetToDifficulty(
                    DifficultyUtils.compactToTarget(msg.nBits) ?? Buffer.alloc(32, 0xff),
                ),
                baseVersion: msg.version,
                requiredVersionBits: 0,
                activationMinNtime: msg.minNtime,
                activatedAtMonotonicNs,
            },
            creation: Date.now(),
            workProtocol: 'sv2_jdp',
        });

        await this.sendFrame(
            Sv2MsgType.SET_CUSTOM_MINING_JOB_SUCCESS,
            serializeSetCustomMiningJobSuccess({
                channelId: msg.channelId,
                requestId: msg.requestId,
                jobId,
            }),
        );
    }

    private reconstructStandardBlock(
        jobData: Pick<StandardJobData, 'jobTemplate' | 'miningJob'> & { headerContext: Sv2HeaderContext },
        submission: { nonce: number; ntime: number; version: number },
        extranoncePrefix: Buffer,
    ): bitcoinjs.Block {
        const versionMask = submission.version ^ jobData.jobTemplate.block.version;
        const block = jobData.miningJob.copyAndUpdateBlock(
            jobData.jobTemplate,
            versionMask,
            submission.nonce,
            extranoncePrefix.toString('hex'),
            FIXED_STANDARD_EXTRANONCE2,
            submission.ntime,
        );
        block.prevHash = Buffer.from(jobData.headerContext.prevHash);
        block.bits = jobData.headerContext.nBits;
        return block;
    }

    private async handleAcceptedShare(
        submission: { nonce: number; ntime: number; version: number },
        channel: ChannelState,
        job: MiningJob,
        jobTemplate: IJobTemplate,
        submissionDifficulty: number,
        jobDifficulty: number,
        hashBuffer: Buffer,
        headerContext: Sv2HeaderContext = this.createHeaderContext(jobTemplate),
        isBlockCandidate = DifficultyUtils.meetsCompactTarget(hashBuffer, headerContext.nBits),
    ): Promise<void> {
        let updatedJobBlock: bitcoinjs.Block = null;
        if (isBlockCandidate) {
            updatedJobBlock = this.reconstructStandardBlock({
                jobTemplate,
                miningJob: job,
                headerContext,
            }, submission, channel.extranoncePrefix);
        }

        await this.recordAcceptedShare(submissionDifficulty, jobDifficulty, jobTemplate, updatedJobBlock, {
            jobId: job.jobId,
            nonce: submission.nonce,
            ntime: submission.ntime,
            version: submission.version,
            extraNonce2: FIXED_STANDARD_EXTRANONCE2,
        });
    }

    private async submitBlockCandidate(
        jobTemplate: IJobTemplate,
        updatedJobBlock: bitcoinjs.Block,
    ): Promise<string | null> {
        await this.ensureClientEntity();
        console.log(`[SV2 ${this.sessionId}] BLOCK FOUND at height ${jobTemplate.blockData.height}`);
        const blockHex = updatedJobBlock.toHex(false);
        const blockSubmissionResult = await this.bitcoinRpcService.SUBMIT_BLOCK(blockHex);
        await this.blocksService.save({
            height: jobTemplate.blockData.height,
            minerAddress: this.address,
            worker: this.workerName,
            sessionId: this.sessionId,
            blockData: blockHex,
            blockSubmissionResult,
            payoutSnapshotId: this.payoutMode === 'pplns'
                ? jobTemplate.blockData.payoutSnapshotId ?? null
                : null,
            payoutMode: this.payoutMode,
        });
        if (this.payoutMode === 'pplns') {
            await this.payoutSnapshotService?.finalizeSnapshotForBlock({
                payoutSnapshotId: jobTemplate.blockData.payoutSnapshotId,
                blockHeight: jobTemplate.blockData.height,
                blockSubmissionResult,
                payoutMode: this.payoutMode,
            });
        }
        await this.notificationService.notifySubscribersBlockFound(
            this.address,
            jobTemplate.blockData.height,
            updatedJobBlock,
            blockSubmissionResult,
        );
        if (this.isSuccessfulBlockSubmission(blockSubmissionResult)) {
            await this.addressSettingsService.resetBestDifficultyAndShares();
        }
        return blockSubmissionResult;
    }

    private async recordAcceptedShare(
        submissionDifficulty: number,
        jobDifficulty: number,
        jobTemplate: IJobTemplate,
        updatedJobBlock: bitcoinjs.Block | null,
        share: { jobId: string; nonce: number; ntime: number; version: number; extraNonce2: string },
        metadata: {
            workProtocol?: 'pool' | 'sv2_jdp';
            blockCandidateResult?: string | null;
            isBlockCandidate?: boolean;
        } = {},
    ): Promise<void> {
        await this.ensureClientEntity();

        let blockSubmissionResult: string = metadata.blockCandidateResult ?? null;
        if (updatedJobBlock != null) {
            blockSubmissionResult = await this.submitBlockCandidate(jobTemplate, updatedJobBlock);
        }

        await this.shareAccountingService?.recordAcceptedShare({
            protocol: metadata.workProtocol === 'sv2_jdp' ? 'sv2_jdp' : 'sv2',
            payoutMode: this.payoutMode,
            workSource: metadata.workProtocol === 'sv2_jdp' ? 'miner_template' : 'pool_template',
            workProtocol: metadata.workProtocol ?? 'pool',
            address: this.address,
            clientName: this.workerName,
            sessionId: this.sessionId,
            clientId: this.clientEntity.id,
            jobId: share.jobId,
            jobTemplateId: jobTemplate.blockData.id,
            blockHeight: jobTemplate.blockData.height,
            creditedDifficulty: jobDifficulty,
            submissionDifficulty,
            networkDifficulty: jobTemplate.blockData.networkDifficulty,
            nonce: share.nonce,
            ntime: share.ntime,
            version: share.version,
            extraNonce2: share.extraNonce2,
            isBlockCandidate: updatedJobBlock != null
                || metadata.isBlockCandidate === true
                || metadata.blockCandidateResult != null,
            blockSubmissionResult,
        });
        await this.statistics.addShares(this.clientEntity, jobDifficulty);
        const now = new Date();
        this.clientEntity.updatedAt = now;
        this.clientEntity.hashRate = this.statistics.hashRate;
        await this.persistClientHashRate(now);

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
        testBlock.transactions = [
            Object.assign(new bitcoinjs.Transaction(), jobTemplate.block.transactions[0]),
            ...(jobTemplate.blockData.transactions == null
                ? jobTemplate.block.transactions.slice(1).map(tx =>
                    Object.assign(new bitcoinjs.Transaction(), tx))
                : jobTemplate.blockData.transactions.map(tx => bitcoinjs.Transaction.fromHex(tx.data))),
        ];

        const coinbaseTx = bitcoinjs.Transaction.fromBuffer(Buffer.concat([
            extendedJob.coinbasePrefix,
            extranoncePrefix,
            submission.extranonce,
            extendedJob.coinbaseSuffix,
        ]));
        coinbaseTx.ins[0].witness = [Buffer.alloc(32)];
        testBlock.transactions[0] = coinbaseTx;
        testBlock.version = submission.version | 0;
        testBlock.nonce = submission.nonce;
        testBlock.timestamp = submission.ntime;
        testBlock.merkleRoot = merkleRoot;
        testBlock.prevHash = Buffer.from(extendedJob.headerContext.prevHash);
        testBlock.bits = extendedJob.headerContext.nBits;
        return testBlock;
    }

    private async handleUpdateChannel(payload: Buffer): Promise<void> {
        const message = deserializeUpdateChannel(new BufferReader(payload));
        const channel = this.channels.get(message.channelId);
        if (channel == null) {
            return;
        }

        await this.enqueueJobOperation(async () => {
            if (this.channels.get(channel.channelId) !== channel) {
                return;
            }

            channel.declaredMaxTarget = Buffer.from(message.maximumTarget);
            if (Number.isFinite(message.nominalHashRate) && message.nominalHashRate > 0) {
                const nextDifficulty = DifficultyUtils.hashRateToDifficulty(
                    message.nominalHashRate,
                    this.targetSharesPerMinute,
                );
                if (Number.isFinite(nextDifficulty) && nextDifficulty > 0) {
                    channel.sessionDifficulty = this.clampDifficulty(DifficultyUtils.clampDifficultyToMaxTarget(
                        nextDifficulty,
                        channel.declaredMaxTarget,
                    ));
                    if (this.channels.get(channel.channelId) === channel) {
                        this.updateStagedFutureDifficulty(channel);
                        await this.sendSetTarget(channel);
                    }
                }
            }
        });
    }

    private handleCloseChannel(payload: Buffer): void {
        const message = deserializeCloseChannel(new BufferReader(payload));
        const channel = this.channels.get(message.channelId);
        if (channel != null) {
            this.stratumV2Service.releaseExtranoncePrefix(message.channelId);
        }
        this.channels.delete(message.channelId);
        if (this.primaryChannelId === message.channelId) {
            this.primaryChannelId = this.channels.keys().next().value ?? null;
        }
        if (this.channels.size === 0) {
            this.closeSocket();
        }
    }

    public enqueueCanonicalJob(jobTemplate: IJobTemplate): Promise<void> {
        if (!this.shouldReceiveCanonicalJob(jobTemplate)) {
            return Promise.resolve();
        }

        return this.enqueueJobOperation(
            () => this.applyCanonicalJob(jobTemplate),
            'canonical',
            jobTemplate.blockData.tipKey,
        );
    }

    public enqueueWorkActivation(template: IBlockTemplate): Promise<void> {
        if (this.destroyed || this.workSelectionEnabled || this.payoutMode !== 'solo') {
            return Promise.resolve();
        }

        const tipKey = this.getQueuedActivationTipKey(template);
        return this.enqueueJobOperation(
            () => this.applyWorkActivation(template),
            tipKey == null ? 'ordered' : 'activation',
            tipKey,
        );
    }

    private enqueueJobOperation(
        operation: () => Promise<void>,
        kind: Sv2JobOperationKind = 'ordered',
        tipKey?: string,
    ): Promise<void> {
        if (this.destroyed) {
            return Promise.resolve();
        }

        return new Promise<void>(resolve => {
            const queuedOperation: QueuedSv2JobOperation = {
                kind,
                operation,
                resolve,
                tipKey,
            };

            if (kind === 'canonical') {
                const activeActivation = this.activeJobOperation?.kind === 'activation'
                    ? this.activeJobOperation
                    : null;
                const pendingActivation = [...this.jobOperationQueue]
                    .reverse()
                    .find(queued => queued.kind === 'activation');
                const activationTipKey = pendingActivation?.tipKey ?? activeActivation?.tipKey;
                if (activationTipKey != null && activationTipKey !== tipKey) {
                    // A late old-tip refresh must not be replayed after a newer
                    // activation. A matching full job is retained behind it.
                    resolve();
                    return;
                }

                const retainedOperations: QueuedSv2JobOperation[] = [];
                for (const queued of this.jobOperationQueue) {
                    if (queued.kind === 'canonical') {
                        // Only the newest not-yet-started canonical job can be
                        // useful to this client. Resolve superseded waiters and
                        // retain the replacement at its newest queue position.
                        queued.resolve();
                    } else {
                        retainedOperations.push(queued);
                    }
                }
                this.jobOperationQueue = retainedOperations;
                this.jobOperationQueue.push(queuedOperation);
            } else if (kind === 'activation') {
                const retainedOperations: QueuedSv2JobOperation[] = [];
                let matchingCanonical: QueuedSv2JobOperation = null;
                for (const queued of this.jobOperationQueue) {
                    if (queued.kind === 'activation') {
                        queued.resolve();
                        continue;
                    }
                    if (queued.kind === 'canonical') {
                        if (queued.tipKey === tipKey) {
                            matchingCanonical?.resolve();
                            matchingCanonical = queued;
                        } else {
                            queued.resolve();
                        }
                        continue;
                    }
                    retainedOperations.push(queued);
                }

                // Target/difficulty mutations keep FIFO order. Obsolete jobs
                // are removed, then the activation runs before a matching full
                // job even if that full job arrived first.
                this.jobOperationQueue = retainedOperations;
                this.jobOperationQueue.push(queuedOperation);
                if (matchingCanonical != null) {
                    this.jobOperationQueue.push(matchingCanonical);
                }
            } else {
                this.jobOperationQueue.push(queuedOperation);
            }

            if (this.jobOperationQueue.length > this.maxQueuedJobOperations) {
                console.warn(
                    `[SV2 ${this.sessionId}] Closing slow client with ${this.jobOperationQueue.length} queued operations `
                    + `(limit ${this.maxQueuedJobOperations})`,
                );
                this.settleQueuedJobOperations();
                this.closeSocket();
                return;
            }

            this.startJobOperationDrain();
        });
    }

    private startJobOperationDrain(): void {
        if (this.drainingJobOperations) {
            return;
        }
        this.drainingJobOperations = true;
        void this.drainJobOperations();
    }

    private async drainJobOperations(): Promise<void> {
        while (!this.destroyed && this.jobOperationQueue.length > 0) {
            const queuedOperation = this.jobOperationQueue.shift();
            this.activeJobOperation = queuedOperation;
            try {
                await queuedOperation.operation();
            } catch (error) {
                if (!this.destroyed) {
                    const message = error instanceof Error ? error.message : String(error);
                    console.error(`[SV2 ${this.sessionId}] Failed to send mining job: ${message}`);
                    this.closeSocket();
                }
            } finally {
                queuedOperation.resolve();
                this.activeJobOperation = null;
            }
        }

        if (this.destroyed) {
            this.settleQueuedJobOperations();
        }
        this.drainingJobOperations = false;
    }

    private settleQueuedJobOperations(): void {
        const queuedOperations = this.jobOperationQueue.splice(0);
        for (const queuedOperation of queuedOperations) {
            queuedOperation.resolve();
        }
    }

    private getQueuedActivationTipKey(template: IBlockTemplate): string | undefined {
        return Number.isSafeInteger(template?.height)
            && typeof template?.previousblockhash === 'string'
            && /^[0-9a-fA-F]{64}$/.test(template.previousblockhash)
            ? `${template.height}:${template.previousblockhash}`
            : undefined;
    }

    private allocateMiningJobId(): { jobId: number; jobIdHex: string } {
        for (let attempt = 0; attempt < 0xffffffff; attempt++) {
            const jobId = this.nextMiningJobId >>> 0;
            this.nextMiningJobId = (jobId + 1) >>> 0;
            if (this.nextMiningJobId === 0) {
                this.nextMiningJobId = 1;
            }
            const isInUse = Array.from(this.channels.values()).some(channel =>
                channel.standardJobs.has(jobId) || channel.extendedJobs.has(jobId));
            if (!isInUse) {
                return { jobId, jobIdHex: jobId.toString(16) };
            }
        }
        throw new Error('No available SV2 mining job IDs');
    }

    private async applyCanonicalJob(jobTemplate: IJobTemplate, force = false): Promise<void> {
        if (!this.shouldReceiveCanonicalJob(jobTemplate)) {
            return;
        }

        const signature = this.getCanonicalJobSignature(jobTemplate);
        const channels = Array.from(this.channels.values())
            .filter(channel => channel.readyForCanonicalJobs)
            .filter(channel => force || channel.lastCanonicalJobSignature !== signature);
        for (const channel of channels) {
            if (this.destroyed || this.channels.get(channel.channelId) !== channel) {
                continue;
            }

            const headerMatchesActiveTip = this.canonicalHeaderMatchesActiveTip(channel, jobTemplate);
            const followsActivatedFuture = channel.activatedFutureTipKey === jobTemplate.blockData.tipKey
                && jobTemplate.blockData.jobType === 'full'
                && headerMatchesActiveTip;
            const sendPrevHash = channel.activeTipKey !== jobTemplate.blockData.tipKey
                || !headerMatchesActiveTip;

            if (sendPrevHash) {
                this.retireChannelJobs(channel);
            } else if (jobTemplate.blockData.clearJobs && !followsActivatedFuture) {
                // A second SetNewPrevHash would invalidate the already-advertised
                // next-height future at the miner. Retire only current server-side
                // jobs and keep that future valid while sending active Some(ntime).
                this.retireChannelJobs(channel, channel.stagedFutureJobId);
            }
            if (channel.channelType === 'extended') {
                await this.sendNewExtendedMiningJob(channel, jobTemplate, sendPrevHash);
            } else {
                await this.sendNewMiningJob(channel, jobTemplate, sendPrevHash);
            }
            channel.activeTipKey = jobTemplate.blockData.tipKey;
            if (channel.activatedFutureTipKey === jobTemplate.blockData.tipKey) {
                channel.activatedFutureTipKey = undefined;
            }
            channel.lastCanonicalJobSignature = signature;
            await this.stageSubsidyFutureJob(channel, jobTemplate);
            this.cleanupRetiredJobs(channel);
        }
    }

    private async applyWorkActivation(template: IBlockTemplate): Promise<void> {
        const activation = this.parseWorkActivation(template);
        if (activation == null) {
            return;
        }

        const activated: Array<{
            channel: ChannelState;
            jobId: number;
        }> = [];
        for (const channel of this.channels.values()) {
            if (!channel.readyForCanonicalJobs || channel.stagedFutureJobId == null) {
                continue;
            }

            const jobId = channel.stagedFutureJobId;
            const jobData = channel.channelType === 'extended'
                ? channel.extendedJobs.get(jobId)
                : channel.standardJobs.get(jobId);
            if (
                jobData == null
                || jobData.retiredAt != null
                || jobData.headerContext != null
                || jobData.expectedHeight !== activation.height
                || !this.isFutureVersionCompatible(jobData.expectedVersion, template)
            ) {
                continue;
            }

            const activatedTemplate = this.createActivatedFutureTemplate(jobData.jobTemplate, template, activation);
            this.retireChannelJobs(channel, jobId);
            jobData.jobTemplate = activatedTemplate;
            jobData.headerContext = {
                ...this.cloneHeaderContext(activation),
                baseVersion: jobData.expectedVersion,
            };
            jobData.miningJob.tipKey = activation.tipKey;
            jobData.miningJob.networkDifficulty = activation.networkDifficulty;
            if (channel.channelType === 'extended') {
                const extendedJob = jobData as ExtendedJobData;
                extendedJob.prevHash = Buffer.from(activation.prevHash);
                extendedJob.nBits = activation.nBits;
                extendedJob.minNtime = activation.minNtime;
                channel.latestExtendedPrevHash = Buffer.from(activation.prevHash);
                channel.latestExtendedNBits = activation.nBits;
                channel.latestExtendedMinNtime = activation.minNtime;
            }
            channel.stagedFutureJobId = undefined;
            channel.activeTipKey = activation.tipKey;
            channel.activatedFutureTipKey = activation.tipKey;
            channel.activePrevHashMinNtime = activation.minNtime;
            channel.activePrevHashAtMonotonicNs = activation.activatedAtMonotonicNs;
            channel.activePrevHashJobId = jobId;
            activated.push({ channel, jobId });
        }

        // All matching jobs are bound before the first socket write, so a share
        // arriving immediately after SetNewPrevHash always sees the new header.
        for (const { channel, jobId } of activated) {
            await this.sendFrame(
                Sv2MsgType.SET_NEW_PREV_HASH,
                serializeSetNewPrevHash({
                    channelId: channel.channelId,
                    jobId,
                    prevHash: Buffer.from(activation.prevHash),
                    minNtime: activation.minNtime,
                    nBits: activation.nBits,
                }),
                SV2_CHANNEL_MSG_FLAG,
            );
        }
    }

    private retireChannelJobs(channel: ChannelState, keepJobId?: number): void {
        const now = Date.now();
        channel.standardJobs.forEach((job, jobId) => {
            if (jobId !== keepJobId && job.retiredAt == null) {
                job.retiredAt = now;
            }
        });
        channel.extendedJobs.forEach((job, jobId) => {
            if (jobId !== keepJobId && job.retiredAt == null) {
                job.retiredAt = now;
            }
        });
        if (channel.stagedFutureJobId !== keepJobId) {
            channel.stagedFutureJobId = undefined;
        }
        this.cleanupRetiredJobs(channel);
    }

    private canonicalHeaderMatchesActiveTip(channel: ChannelState, jobTemplate: IJobTemplate): boolean {
        const activeJobs = channel.channelType === 'extended'
            ? channel.extendedJobs.values()
            : channel.standardJobs.values();
        for (const job of activeJobs) {
            if (
                job.retiredAt == null
                && job.headerContext?.tipKey === jobTemplate.blockData.tipKey
                && job.headerContext.nBits === jobTemplate.block.bits
                && job.headerContext.prevHash.equals(jobTemplate.block.prevHash)
            ) {
                return true;
            }
        }
        return false;
    }

    private shouldReceiveCanonicalJob(jobTemplate: IJobTemplate): boolean {
        return !this.destroyed
            && !this.workSelectionEnabled
            && (jobTemplate.blockData.payoutMode === 'all'
                || jobTemplate.blockData.payoutMode === this.payoutMode)
            && (this.payoutMode !== 'pplns'
                || jobTemplate.blockData.payoutOutputs?.length > 0);
    }

    private getCanonicalJobSignature(jobTemplate: IJobTemplate): string {
        return [
            jobTemplate.blockData.id,
            jobTemplate.block.timestamp,
            jobTemplate.blockData.clearJobs,
            jobTemplate.blockData.jobType,
            jobTemplate.blockData.payoutMode,
        ].join(':');
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
        const targetDiff = this.clampDifficulty(this.statistics.getSuggestedDifficulty(this.sessionDifficulty));
        if (targetDiff == null || targetDiff === this.sessionDifficulty || !Number.isFinite(targetDiff)) {
            return;
        }

        await this.enqueueJobOperation(async () => {
            this.sessionDifficulty = targetDiff;
            for (const channel of this.channels.values()) {
                channel.sessionDifficulty = this.clampDifficulty(DifficultyUtils.clampDifficultyToMaxTarget(
                    targetDiff,
                    channel.declaredMaxTarget,
                ));
                this.updateStagedFutureDifficulty(channel);
                await this.sendSetTarget(channel);
            }

            const jobTemplate = this.stratumV2Service.getLatestCanonicalJob(this.payoutMode);
            if (jobTemplate != null) {
                const refreshedTemplate: IJobTemplate = {
                    ...jobTemplate,
                    block: Object.assign(new bitcoinjs.Block(), jobTemplate.block, {
                        timestamp: Math.max(jobTemplate.block.timestamp, Math.floor(Date.now() / 1000)),
                    }),
                    blockData: { ...jobTemplate.blockData, clearJobs: true },
                };
                await this.applyCanonicalJob(refreshedTemplate, true);
            }
        });
    }

    private async sendNewMiningJob(
        channel: ChannelState,
        jobTemplate: IJobTemplate,
        sendPrevHash: boolean,
        isFuture = false,
    ): Promise<number | null> {
        if (this.address == null) {
            return null;
        }

        const payoutInformation = this.getPayoutInformation(jobTemplate, this.address);
        if (payoutInformation == null) {
            return null;
        }
        const { jobId, jobIdHex } = this.allocateMiningJobId();
        const job = new MiningJob(
            this.network,
            jobIdHex,
            payoutInformation,
            jobTemplate,
        );
        // The standard job needs only its coinbase-derived Merkle root. Parsing
        // and cloning the full transaction body here made canonical fanout O(body
        // size * channel count); retain that work solely for a block candidate.
        const merkleRoot = job.buildCoinbaseMerkleRoot(
            channel.extranoncePrefix.toString('hex'),
            FIXED_STANDARD_EXTRANONCE2,
        );
        channel.jobIdToDifficulty.set(jobId, channel.sessionDifficulty);
        channel.jobIdToMerkleRoot.set(jobId, merkleRoot);
        const headerContext = isFuture ? undefined : this.createHeaderContext(jobTemplate, channel);
        channel.standardJobs.set(jobId, {
            merkleRoot,
            jobTemplate,
            miningJob: job,
            expectedHeight: jobTemplate.blockData.height,
            expectedVersion: jobTemplate.block.version,
            headerContext,
            creation: Date.now(),
        });

        await this.sendFrame(
            Sv2MsgType.NEW_MINING_JOB,
            serializeNewMiningJob({
                channelId: channel.channelId,
                jobId,
                minNtime: sendPrevHash || isFuture ? null : jobTemplate.block.timestamp,
                version: jobTemplate.block.version,
                merkleRoot,
            }),
            SV2_CHANNEL_MSG_FLAG,
        );

        if (sendPrevHash) {
            const activatedAtMonotonicNs = process.hrtime.bigint();
            headerContext.activationMinNtime = jobTemplate.block.timestamp;
            headerContext.activatedAtMonotonicNs = activatedAtMonotonicNs;
            channel.activePrevHashMinNtime = jobTemplate.block.timestamp;
            channel.activePrevHashAtMonotonicNs = activatedAtMonotonicNs;
            channel.activePrevHashJobId = jobId;
            channel.activeTipKey = jobTemplate.blockData.tipKey;
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
        return jobId;
    }

    private async sendNewExtendedMiningJob(
        channel: ChannelState,
        jobTemplate: IJobTemplate,
        sendPrevHash: boolean,
        isFuture = false,
    ): Promise<number | null> {
        if (this.address == null) {
            return null;
        }

        const payoutInformation = this.getPayoutInformation(jobTemplate, this.address);
        if (payoutInformation == null) {
            return null;
        }
        const { jobId, jobIdHex } = this.allocateMiningJobId();
        const job = new MiningJob(
            this.network,
            jobIdHex,
            payoutInformation,
            jobTemplate,
        );
        const merklePath = jobTemplate.merkle_branch.map(branch => Buffer.from(branch, 'hex'));
        const totalExtranonceSize = channel.extranoncePrefix.length + channel.extranonceSize;
        const coinbasePrefix = patchCoinbasePrefixVarint(job.getCoinbasePrefixBuffer(), totalExtranonceSize);
        const coinbaseSuffix = job.getCoinbaseSuffixBuffer();

        const headerContext = isFuture ? undefined : this.createHeaderContext(jobTemplate, channel);
        const prevHash = headerContext == null
            ? Buffer.alloc(32)
            : Buffer.from(headerContext.prevHash);
        const nBits = headerContext?.nBits ?? 0;
        const minNtime = headerContext?.minNtime ?? 0;

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
            expectedHeight: jobTemplate.blockData.height,
            expectedVersion: jobTemplate.block.version,
            headerContext,
            creation: Date.now(),
        });

        await this.sendFrame(
            Sv2MsgType.NEW_EXTENDED_MINING_JOB,
            serializeNewExtendedMiningJob({
                channelId: channel.channelId,
                jobId,
                minNtime: sendPrevHash || isFuture ? null : jobTemplate.block.timestamp,
                version: jobTemplate.block.version,
                versionRollingAllowed: this.versionRollingEnabled,
                merklePath,
                coinbasePrefix,
                coinbaseSuffix,
            }),
            SV2_CHANNEL_MSG_FLAG,
        );

        if (sendPrevHash) {
            const activatedAtMonotonicNs = process.hrtime.bigint();
            headerContext.activationMinNtime = minNtime;
            headerContext.activatedAtMonotonicNs = activatedAtMonotonicNs;
            channel.activePrevHashMinNtime = minNtime;
            channel.activePrevHashAtMonotonicNs = activatedAtMonotonicNs;
            channel.activePrevHashJobId = jobId;
            channel.latestExtendedPrevHash = prevHash;
            channel.latestExtendedNBits = nBits;
            channel.latestExtendedMinNtime = minNtime;
            channel.activeTipKey = jobTemplate.blockData.tipKey;
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
        return jobId;
    }

    private async stageSubsidyFutureJob(channel: ChannelState, sourceTemplate: IJobTemplate): Promise<void> {
        if (
            this.payoutMode !== 'solo'
            || this.workSelectionEnabled
            || !channel.readyForCanonicalJobs
            || !Number.isSafeInteger(sourceTemplate.blockData.height)
            || sourceTemplate.blockData.height < 0
            || sourceTemplate.blockData.height >= Number.MAX_SAFE_INTEGER
        ) {
            return;
        }

        const expectedHeight = sourceTemplate.blockData.height + 1;
        const expectedVersion = sourceTemplate.block.version;
        if (channel.stagedFutureJobId != null) {
            const staged = channel.channelType === 'extended'
                ? channel.extendedJobs.get(channel.stagedFutureJobId)
                : channel.standardJobs.get(channel.stagedFutureJobId);
            if (
                staged != null
                && staged.retiredAt == null
                && staged.headerContext == null
                && staged.expectedHeight === expectedHeight
                && (staged.expectedVersion >>> 0) === (expectedVersion >>> 0)
            ) {
                return;
            }
            if (staged != null && staged.retiredAt == null) {
                staged.retiredAt = Date.now();
            }
            channel.stagedFutureJobId = undefined;
        }

        const futureTemplate = this.createSubsidyFutureTemplate(expectedHeight, expectedVersion);
        const jobId = channel.channelType === 'extended'
            ? await this.sendNewExtendedMiningJob(channel, futureTemplate, false, true)
            : await this.sendNewMiningJob(channel, futureTemplate, false, true);
        if (jobId != null) {
            channel.stagedFutureJobId = jobId;
        }
        this.cleanupRetiredJobs(channel);
    }

    private createSubsidyFutureTemplate(height: number, version: number): IJobTemplate {
        const block = new bitcoinjs.Block();
        const placeholderCoinbase = new bitcoinjs.Transaction();
        placeholderCoinbase.version = 2;
        placeholderCoinbase.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff);
        placeholderCoinbase.ins[0].witness = [Buffer.alloc(32)];
        block.version = version;
        block.prevHash = Buffer.alloc(32);
        block.bits = 0;
        block.timestamp = Math.floor(Date.now() / 1000);
        block.transactions = [placeholderCoinbase];
        block.merkleRoot = placeholderCoinbase.getHash(false);
        block.witnessCommit = Buffer.from(EMPTY_WITNESS_COMMITMENT_HASH, 'hex');

        const halvingInterval = this.getOptionalPositiveIntegerConfig('SUBSIDY_HALVING_INTERVAL');
        const coinbasevalue = calculateBlockSubsidySats(
            height,
            this.getNetworkName(),
            halvingInterval,
        );
        const id = `sv2-future:${this.sessionId}:${height}:${++this.futureTemplateCounter}`;
        return {
            block,
            merkle_branch: [],
            blockData: {
                id,
                creation: Date.now(),
                coinbasevalue,
                networkDifficulty: 0,
                height,
                tipKey: `future:${height}:${version >>> 0}`,
                clearJobs: true,
                isNewBlock: true,
                jobType: 'empty',
                payoutMode: 'solo',
                transactions: [],
            },
        };
    }

    private parseWorkActivation(template: IBlockTemplate): Sv2WorkActivation | null {
        if (
            template?.jobType !== 'empty'
            || (template.payoutMode !== 'solo' && template.payoutMode !== 'pplns')
            || !Number.isSafeInteger(template.height)
            || template.height < 0
            || !Number.isInteger(template.version)
            || !Number.isInteger(template.vbrequired)
            || template.vbrequired < 0
            || template.vbrequired > 0xffffffff
            || !Number.isInteger(template.mintime)
            || template.mintime < 0
            || template.mintime > 0xffffffff
            || !/^[0-9a-fA-F]{64}$/.test(template.previousblockhash ?? '')
            || !/^[0-9a-fA-F]{8}$/.test(template.bits ?? '')
        ) {
            return null;
        }

        const nBits = Number.parseInt(template.bits, 16);
        const target = DifficultyUtils.compactToTarget(nBits);
        if (target == null) {
            return null;
        }
        return {
            tipKey: `${template.height}:${template.previousblockhash}`,
            prevHash: Buffer.from(template.previousblockhash, 'hex').reverse(),
            nBits,
            minNtime: template.mintime,
            height: template.height,
            version: template.version,
            networkDifficulty: DifficultyUtils.targetToDifficulty(target),
            baseVersion: template.version,
            requiredVersionBits: template.vbrequired >>> 0,
            activationMinNtime: template.mintime,
            activatedAtMonotonicNs: process.hrtime.bigint(),
        };
    }

    private createActivatedFutureTemplate(
        stagedTemplate: IJobTemplate,
        rawTemplate: IBlockTemplate,
        activation: Sv2WorkActivation,
    ): IJobTemplate {
        const block = Object.assign(new bitcoinjs.Block(), stagedTemplate.block, {
            prevHash: Buffer.from(activation.prevHash),
            bits: activation.nBits,
            timestamp: activation.minNtime,
            // The future job's version was already sent to the miner. GBT may
            // change BIP320 general-purpose bits without making it incompatible.
            version: stagedTemplate.block.version,
        });
        block.transactions = stagedTemplate.block.transactions.map(transaction =>
            Object.assign(new bitcoinjs.Transaction(), transaction));
        return {
            ...stagedTemplate,
            block,
            blockData: {
                ...stagedTemplate.blockData,
                networkDifficulty: activation.networkDifficulty,
                height: activation.height,
                tipKey: activation.tipKey,
                clearJobs: true,
                isNewBlock: true,
                jobType: 'empty',
                payoutMode: 'solo',
                notificationEventId: rawTemplate.notificationEventId,
                notificationPublishedAtMs: rawTemplate.notificationPublishedAtMs,
            },
        };
    }

    private createHeaderContext(
        jobTemplate: IJobTemplate,
        channel?: ChannelState,
    ): Sv2HeaderContext {
        return {
            tipKey: jobTemplate.blockData.tipKey,
            prevHash: Buffer.from(jobTemplate.block.prevHash),
            nBits: jobTemplate.block.bits,
            minNtime: jobTemplate.block.timestamp,
            height: jobTemplate.blockData.height,
            networkDifficulty: jobTemplate.blockData.networkDifficulty,
            baseVersion: jobTemplate.block.version,
            requiredVersionBits: jobTemplate.blockData.requiredVersionBits ?? 0,
            activationMinNtime: channel?.activePrevHashMinNtime,
            activatedAtMonotonicNs: channel?.activePrevHashAtMonotonicNs,
        };
    }

    private isFutureVersionCompatible(stagedVersion: number, template: IBlockTemplate): boolean {
        const staged = stagedVersion >>> 0;
        const authoritative = template.version >>> 0;
        const required = template.vbrequired >>> 0;
        return ((staged ^ authoritative) & BIP320_CONSENSUS_VERSION_MASK) === 0
            && (staged & required) === required;
    }

    private isSubmissionHeaderValid(
        headerContext: Sv2HeaderContext,
        submittedVersion: number,
        submittedNtime: number,
    ): boolean {
        const submitted = submittedVersion >>> 0;
        const base = headerContext.baseVersion >>> 0;
        if (this.versionRollingEnabled) {
            if (((submitted ^ base) & BIP320_CONSENSUS_VERSION_MASK) !== 0) {
                return false;
            }
        } else if (submitted !== base) {
            return false;
        }
        if ((submitted & headerContext.requiredVersionBits) !== headerContext.requiredVersionBits) {
            return false;
        }
        return Number.isInteger(submittedNtime)
            && submittedNtime >= headerContext.minNtime
            && submittedNtime <= 0xffffffff;
    }

    private cloneHeaderContext(context: Sv2HeaderContext): Sv2HeaderContext {
        return {
            ...context,
            prevHash: Buffer.from(context.prevHash),
        };
    }

    private updateStagedFutureDifficulty(channel: ChannelState): void {
        if (channel.stagedFutureJobId != null) {
            channel.jobIdToDifficulty.set(channel.stagedFutureJobId, channel.sessionDifficulty);
        }
    }

    private cleanupRetiredJobs(channel: ChannelState): void {
        const cutoff = Date.now() - this.jobRetentionMs;
        const jobs = channel.channelType === 'extended'
            ? channel.extendedJobs
            : channel.standardJobs;
        let latestActiveJobId: number = null;
        let latestActiveCreation = Number.NEGATIVE_INFINITY;
        for (const [jobId, job] of jobs.entries()) {
            if (
                job.retiredAt == null
                && job.headerContext != null
                && job.creation >= latestActiveCreation
            ) {
                latestActiveJobId = jobId;
                latestActiveCreation = job.creation;
            }
        }
        const protectedJobIds = new Set<number>();
        if (channel.stagedFutureJobId != null) {
            protectedJobIds.add(channel.stagedFutureJobId);
        }
        if (latestActiveJobId != null) {
            protectedJobIds.add(latestActiveJobId);
        }
        const activePrevHashJob = channel.activePrevHashJobId == null
            ? null
            : jobs.get(channel.activePrevHashJobId);
        if (activePrevHashJob?.retiredAt == null) {
            protectedJobIds.add(channel.activePrevHashJobId);
        }

        for (const [jobId, job] of channel.standardJobs.entries()) {
            const expiredRetiredJob = job.retiredAt != null && job.retiredAt <= cutoff;
            const expiredSameTipJob = job.retiredAt == null
                && job.headerContext != null
                && job.creation <= cutoff
                && !protectedJobIds.has(jobId);
            if (expiredRetiredJob || expiredSameTipJob) {
                this.deleteChannelJob(channel, jobId);
            }
        }
        for (const [jobId, job] of channel.extendedJobs.entries()) {
            const expiredRetiredJob = job.retiredAt != null && job.retiredAt <= cutoff;
            const expiredSameTipJob = job.retiredAt == null
                && job.headerContext != null
                && job.creation <= cutoff
                && !protectedJobIds.has(jobId);
            if (expiredRetiredJob || expiredSameTipJob) {
                this.deleteChannelJob(channel, jobId);
            }
        }

        const retainedJobCount = channel.standardJobs.size + channel.extendedJobs.size;
        if (retainedJobCount > this.maxRetainedJobsPerChannel) {
            throw new Error(
                `SV2 channel ${channel.channelId} retained ${retainedJobCount} jobs `
                + `(limit ${this.maxRetainedJobsPerChannel})`,
            );
        }
    }

    private deleteChannelJob(channel: ChannelState, jobId: number): void {
        channel.standardJobs.delete(jobId);
        channel.extendedJobs.delete(jobId);
        channel.jobIdToDifficulty.delete(jobId);
        channel.jobIdToMerkleRoot.delete(jobId);
    }

    private buildHeader(
        headerContext: Sv2HeaderContext,
        merkleRoot: Buffer,
        version: number,
        timestamp: number,
        nonce: number,
    ): Buffer {
        const header = Buffer.alloc(80);
        header.writeUInt32LE(version >>> 0, 0);
        headerContext.prevHash.copy(header, 4);
        merkleRoot.copy(header, 36);
        header.writeUInt32LE(timestamp >>> 0, 68);
        header.writeUInt32LE(headerContext.nBits >>> 0, 72);
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

    private async sendShareSuccess(
        channelId: number,
        sequenceNumber: number,
        creditedDifficulty: number,
    ): Promise<void> {
        await this.sendFrame(
            Sv2MsgType.SUBMIT_SHARES_SUCCESS,
            serializeSubmitSharesSuccess({
                channelId,
                lastSequenceNumber: sequenceNumber,
                newSubmitsAcceptedCount: 1,
                newSharesSum: BigInt(Math.round(creditedDifficulty)),
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
        if (this.destroyed || this.socket.destroyed || this.socket.writableEnded) {
            return;
        }

        const socketBufferedBytes = Number.isFinite(this.socket.writableLength)
            ? this.socket.writableLength
            : 0;
        const bufferedBytes = Math.max(socketBufferedBytes, this.pendingSocketWriteBytes);
        if (bufferedBytes + data.length > this.maxSocketBufferBytes) {
            const error = new Error(
                `SV2 socket buffer would reach ${bufferedBytes + data.length} bytes `
                + `(limit ${this.maxSocketBufferBytes})`,
            );
            console.warn(`[SV2 ${this.sessionId}] ${error.message}; closing slow client`);
            this.closeSocket();
            throw error;
        }

        this.pendingSocketWriteBytes += data.length;
        try {
            await new Promise<void>((resolve, reject) => {
                let completed = false;
                const finish = (error?: Error): void => {
                    if (completed) {
                        return;
                    }
                    completed = true;
                    clearTimeout(timeout);
                    if (error != null) {
                        reject(error);
                    } else {
                        resolve();
                    }
                };
                const timeout = setTimeout(() => {
                    const error = new Error(
                        `SV2 socket write callback exceeded ${this.socketWriteTimeoutMs}ms`,
                    );
                    console.warn(`[SV2 ${this.sessionId}] ${error.message}; closing slow client`);
                    this.closeSocket();
                    finish(error);
                }, this.socketWriteTimeoutMs);
                timeout.unref?.();

                try {
                    this.socket.write(data, error => finish(error ?? undefined));
                } catch (error) {
                    finish(error instanceof Error ? error : new Error(String(error)));
                }
            });
        } finally {
            this.pendingSocketWriteBytes = Math.max(0, this.pendingSocketWriteBytes - data.length);
        }
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
                    payoutMode: this.payoutMode,
                    bestDifficulty: 0,
                });
            })();
        }

        await this.creatingEntity;
    }

    private async persistClientHashRate(now: Date): Promise<void> {
        if (this.clientEntity?.id == null) {
            return;
        }

        const hashRate = Number(this.statistics?.hashRate ?? 0);
        if (!Number.isFinite(hashRate) || hashRate <= 0) {
            return;
        }

        const intervalMs = this.getHashRatePersistIntervalMs();
        const nowMs = now.getTime();
        if (this.lastHashRatePersistedAt > 0 && nowMs - this.lastHashRatePersistedAt < intervalMs) {
            return;
        }

        this.lastHashRatePersistedAt = nowMs;
        try {
            await this.clientService.updateHashRate(this.clientEntity.id, hashRate, now);
        } catch (error) {
            console.error(`Failed to persist SV2 client hashrate: ${error.message}`);
        }
    }

    private getHashRatePersistIntervalMs(): number {
        const configured = Number(this.configService.get<string>('CLIENT_HASHRATE_PERSIST_INTERVAL_MS'));
        if (Number.isFinite(configured) && configured >= 0) {
            return configured;
        }

        return DEFAULT_CLIENT_HASHRATE_PERSIST_INTERVAL_MS;
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
        const difficulty = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_START_DIFFICULTY;
        return this.clampDifficulty(difficulty);
    }

    private getMinimumDifficulty(): number {
        return this.getConfiguredMinimumDifficulty() ?? DEFAULT_MIN_DIFFICULTY;
    }

    private getConfiguredMinimumDifficulty(): number | null {
        const configured = parseFloat(
            this.configService.get<string>('STRATUM_MIN_DIFFICULTY')
            ?? process.env.STRATUM_MIN_DIFFICULTY
            ?? '',
        );
        return Number.isFinite(configured) && configured > 0 ? configured : null;
    }

    private clampDifficulty(difficulty: number | null): number | null {
        if (difficulty == null || !Number.isFinite(difficulty)) {
            return null;
        }
        const configuredMinimum = this.getConfiguredMinimumDifficulty();
        return configuredMinimum == null ? difficulty : Math.max(difficulty, configuredMinimum);
    }

    private disableApplicationIdleTimeout(): void {
        if (typeof this.socket.setTimeout === 'function') {
            this.socket.setTimeout(0);
        }
    }

    private getTargetSharesPerMinute(): number {
        const configured = parseFloat(this.configService.get<string>('SV2_TARGET_SHARES_PER_MINUTE') ?? '');
        return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TARGET_SHARES_PER_MINUTE;
    }

    private getDifficultyCheckIntervalMs(): number {
        const configured = parseInt(this.configService.get<string>('SV2_DIFFICULTY_CHECK_INTERVAL_MS') ?? '', 10);
        return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DIFFICULTY_CHECK_INTERVAL_MS;
    }

    private getOptionalPositiveIntegerConfig(key: string): number | undefined {
        const configured = Number(this.configService.get<string>(key));
        return Number.isSafeInteger(configured) && configured > 0 ? configured : undefined;
    }

    private getPositiveIntegerConfig(key: string, fallback: number): number {
        return this.getOptionalPositiveIntegerConfig(key) ?? fallback;
    }

    private getPayoutInformation(jobTemplate: IJobTemplate, fallbackAddress: string): AddressObject[] | null {
        if (this.payoutMode === 'pplns') {
            return jobTemplate.blockData.payoutOutputs?.length > 0
                ? jobTemplate.blockData.payoutOutputs
                : null;
        }

        return [{ address: fallbackAddress, percent: 100 }];
    }

    private getCreditedDifficulty(
        jobDifficulty: number,
        submissionDifficulty: number,
        meetsJobTarget: boolean,
    ): number {
        if (meetsJobTarget || !Number.isFinite(submissionDifficulty) || submissionDifficulty <= 0) {
            return jobDifficulty;
        }

        return Math.min(jobDifficulty, submissionDifficulty);
    }

    private validateCoinbasePayoutOutputs(
        coinbaseTxBytes: Buffer,
        jobTemplate: IJobTemplate,
        payoutInformation: AddressObject[],
    ): { valid: boolean; errorCode?: string } {
        let transaction: bitcoinjs.Transaction;
        try {
            transaction = bitcoinjs.Transaction.fromBuffer(coinbaseTxBytes);
        } catch {
            return { valid: false, errorCode: 'invalid-coinbase-transaction' };
        }

        const expectedOutputs = this.buildExpectedPayoutOutputs(payoutInformation, jobTemplate.blockData.coinbasevalue);
        const submittedOutputs = transaction.outs
            .filter(output => !this.isWitnessCommitmentOutput(output.script))
            .filter(output => BigInt(output.value) !== 0n)
            .map(output => ({
                value: BigInt(output.value),
                scriptPubKey: Buffer.from(output.script),
            }));

        if (submittedOutputs.length !== expectedOutputs.length) {
            return { valid: false, errorCode: 'invalid-coinbase-payout-outputs' };
        }
        for (let i = 0; i < expectedOutputs.length; i++) {
            const expected = expectedOutputs[i];
            const submitted = submittedOutputs[i];
            if (submitted.value !== expected.value || !submitted.scriptPubKey.equals(expected.scriptPubKey)) {
                return { valid: false, errorCode: 'invalid-coinbase-payout-outputs' };
            }
        }
        return { valid: true };
    }

    private buildExpectedPayoutOutputs(
        payoutInformation: AddressObject[],
        coinbaseValue: number,
    ): { value: bigint; scriptPubKey: Buffer }[] {
        let rewardBalance = BigInt(Math.max(0, Math.floor(coinbaseValue)));
        const outputs = payoutInformation.map(recipientAddress => {
            const value = recipientAddress.amountSats == null
                ? BigInt(Math.floor(((recipientAddress.percent ?? 0) / 100) * coinbaseValue))
                : BigInt(recipientAddress.amountSats);
            rewardBalance -= value;
            return {
                value,
                scriptPubKey: bitcoinjs.address.toOutputScript(recipientAddress.address, this.network),
            };
        });
        if (outputs.length > 0 && rewardBalance !== 0n) {
            outputs[0] = {
                ...outputs[0],
                value: outputs[0].value + rewardBalance,
            };
        }
        return outputs;
    }

    private isWitnessCommitmentOutput(script: Buffer): boolean {
        return script.length === 38
            && script[0] === bitcoinjs.opcodes.OP_RETURN
            && script[1] === 0x24
            && script.subarray(2, 6).equals(Buffer.from('aa21a9ed', 'hex'));
    }

    private isSuccessfulBlockSubmission(result?: string | null): boolean {
        return result == null || result === 'SUCCESS!';
    }

    private getNetwork(): bitcoinjs.networks.Network {
        const networkConfig = this.getNetworkName();
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

    private getNetworkName(): BitcoinNetworkName {
        const networkConfig = this.configService.get<string>('NETWORK');
        if (networkConfig === 'mainnet' || networkConfig === 'testnet' || networkConfig === 'regtest') {
            return networkConfig;
        }
        throw new Error('Invalid network configuration');
    }

    private logProtocolError(error: Error): void {
        if (!this.isNoisyAuthFailure(error)) {
            console.error(`[SV2 ${this.sessionId}] ${error.message}`);
            return;
        }

        if (process.env.SV2_AUTH_FAILURE_LOG_ENABLED?.toLowerCase() !== 'true') {
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
