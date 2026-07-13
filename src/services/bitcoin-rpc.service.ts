import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import { BehaviorSubject, filter, interval, ReplaySubject, shareReplay, startWith, Subject, switchMap } from 'rxjs';
import { PayoutSnapshotService } from '../ORM/payout-snapshot/payout-snapshot.service';
import { RpcBlockService } from '../ORM/rpc-block/rpc-block.service';
import * as zmq from 'zeromq';

import { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { IMiningInfo } from '../models/bitcoin-rpc/IMiningInfo';
import {
    BlockTemplateUpdate,
    RedisMessagingService,
    Sv1BridgeUpdate,
    Sv1PrestageActivation,
    Sv1PrestageUpdate,
} from './redis-messaging.service';
import {
    BitcoinNetworkName,
    calculateBlockSubsidySats,
    createSubsidyOnlyBlockTemplate,
} from './subsidy-only-template.factory';

type TemplateRefreshReason = 'startup' | 'new_block' | 'periodic' | 'longpoll';

interface BlockNotificationTrace {
    eventId: string;
    reason: TemplateRefreshReason;
    startedWallMs: number;
    startedMonotonic: bigint;
    sourceNotificationReceivedAtMs?: number;
    templateSource?: string;
    stages: Record<string, number>;
}

interface TemplateRpcSource {
    name: string;
    client: AxiosInstance;
    latestLongpollId: string | null;
    longpollLoopStarted: boolean;
}

type BridgePublishResult = 'published' | 'skipped' | 'failed';
type UrgentBridgePublishResult = 'acknowledged' | 'fallback-started' | 'failed';

interface BridgePublishReservation {
    tipKey: string;
    attemptId: number;
}

interface StoredBlockTemplateEnvelope {
    schemaVersion: 1;
    templates: IBlockTemplate[];
}

interface PplnsSubsidyBridgeSeed {
    candidateHeight: number;
    subsidySats: number;
    basisBits: string;
    payoutSnapshotId: string;
    payoutOutputs: NonNullable<IBlockTemplate['payoutOutputs']>;
    preparedAtMs: number;
}

interface CanonicalEmissionState {
    height: number;
    previousBlockHash: string;
    publishedAtMs?: number;
    signature: string;
}

interface PendingTemplatePersistence {
    tipHeight: number;
    templates: IBlockTemplate[];
    trace: BlockNotificationTrace;
}

interface PendingPplnsTemplatePublication {
    blockTemplate: IBlockTemplate;
    soloTemplate: IBlockTemplate;
    tipHeight: number;
    forceCleanJobs: boolean;
    tipKey: string;
    templateSignature: string;
    trace: BlockNotificationTrace;
}

const DEFAULT_PPLNS_BRIDGE_SEED_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_SV1_BRIDGE_PUBLISH_BUDGET_MS = 10;
const PPLNS_LISTENER_CONFIG_KEYS = [
    'PPLNS_STRATUM_PORTS',
    'PPLNS_SECURE_STRATUM_PORTS',
    'PPLNS_STRATUM_V2_PORTS',
    'PPLNS_SV2_JDP_PORTS',
    'PPLNS_SV2_TDP_PORTS',
    'PPLNS_DATUM_PORTS',
] as const;

@Injectable()
export class BitcoinRpcService implements OnModuleInit {

    
    private client: AxiosInstance;
    private readonly auxiliaryTemplateSources: TemplateRpcSource[] = [];
    private _newBlockTemplate$: BehaviorSubject<IBlockTemplate> = new BehaviorSubject(undefined);
    private _newSv1BridgeTemplate$ = new ReplaySubject<IBlockTemplate>(1);
    private _newSv1PrestageActivation$ = new ReplaySubject<Sv1PrestageActivation>(2);
    private _newSv1PrestageTemplate$ = new ReplaySubject<IBlockTemplate>(2);
    private resetTemplateInterval$ = new Subject<void>();
    private rpcRequestId = 0;
    private readonly processedTemplateEvents = new Set<string>();
    private workerTemplateTail: Promise<void> = Promise.resolve();
    private pendingTemplatePersistence: PendingTemplatePersistence | null = null;
    private persistenceDrainPromise: Promise<void> | null = null;
    private periodicTemplateRefresh: Promise<void> | null = null;
    private templatePublicationTail: Promise<void> = Promise.resolve();
    private pendingPplnsTemplatePublication: PendingPplnsTemplatePublication | null = null;
    private activePplnsTemplatePublication: PendingPplnsTemplatePublication | null = null;
    private pplnsTemplatePublicationPromise: Promise<void> | null = null;
    private readonly latestBridgeTemplates = new Map<'solo' | 'pplns', IBlockTemplate>();
    private readonly canonicalEmissionStates = new Map<'solo' | 'pplns' | 'all', CanonicalEmissionState>();
    private readonly lastPublishedBridgeTipKeys = new Map<'solo' | 'pplns', BridgePublishReservation>();
    private readonly lastPublishedActivationTipKeys = new Map<'solo' | 'pplns', BridgePublishReservation>();
    private bridgePublishAttemptId = 0;
    private readonly subsidyValidatedTemplates = new WeakSet<IBlockTemplate>();
    private readonly lastPublishedPrestageKeys = new Map<'solo' | 'pplns', string>();
    private readonly pplnsSubsidyBridgeSeeds = new Map<number, PplnsSubsidyBridgeSeed>();
    private pplnsSeedPrecomputeTail: Promise<void> = Promise.resolve();
    private pplnsSeedPrecomputeGeneration = 0;
    private pendingPplnsSeedPrecompute: { template: IBlockTemplate; generation: number } | null = null;
    private pplnsSeedPrecomputeRunning = false;
    private lastPublishedTemplateSignature: string | null = null;
    private lastPublishedTipKey: string | null = null;
    private lastPublishedCandidateHeight = -1;
    /** Atomically reserves the fastest forward height before any Redis await. */
    private highestUrgentCandidateHeight = -1;
    private highestPublishedCandidateHeight = -1;
    private reorgVerificationFenceHeight = -1;
    private latestLongpollId: string | null = null;
    private longpollLoopStarted = false;
    private latestLegacyReadyTipKey: string | null = null;

    public miningInfo: IMiningInfo;
    public newBlockTemplate$ = this._newBlockTemplate$.pipe(filter(block => block != null), shareReplay({ refCount: true, bufferSize: 1 }));
    public newSv1BridgeTemplate$ = this._newSv1BridgeTemplate$.pipe(shareReplay({ refCount: true, bufferSize: 1 }));
    public newSv1PrestageActivation$ = this._newSv1PrestageActivation$.pipe(
        shareReplay({ refCount: true, bufferSize: 2 }),
    );
    public newSv1PrestageTemplate$ = this._newSv1PrestageTemplate$.pipe(shareReplay({ refCount: true, bufferSize: 2 }));
    /** Core-authoritative early header activation; currently carries the solo subsidy bridge body. */
    public workActivationTemplate$ = this.newSv1BridgeTemplate$;

    constructor(
        private readonly configService: ConfigService,
        private rpcBlockService: RpcBlockService,
        private readonly redisMessagingService: RedisMessagingService,
        @Optional()
        private readonly payoutSnapshotService?: PayoutSnapshotService
    ) {

    }

    async onModuleInit() {

        const url = this.configService.get('BITCOIN_RPC_URL');
        const user = this.configService.get('BITCOIN_RPC_USER');
        const pass = this.configService.get('BITCOIN_RPC_PASSWORD');
        const port = parseInt(this.configService.get('BITCOIN_RPC_PORT'));
        const timeout = parseInt(this.configService.get('BITCOIN_RPC_TIMEOUT'));

        const baseURL = this.buildRpcUrl(url, port);
        this.client = axios.create({
            baseURL,
            timeout,
            auth: {
                username: user,
                password: pass
            }
        });
        this.configureAuxiliaryTemplateSources({ user, pass, port, timeout });

        console.log(`MASTER? ${process.env.MASTER}`)
        if (process.env.MASTER != 'true') {
            await this.loadLatestMiningInfoForReplayProcess();
            if (process.env.API_ONLY != 'true') {
                if (typeof this.redisMessagingService.subscribeSv1PrestageActivations === 'function') {
                    await this.redisMessagingService.subscribeSv1PrestageActivations(async activation => {
                        this.handleSv1PrestageActivation(activation);
                    });
                }
                await this.redisMessagingService.subscribeSv1BridgeUpdates(async update => {
                    // A new-tip bridge is an interrupt, not canonical replay work.
                    // It has its own Redis socket and must never sit behind a full
                    // template GET/JSON parse on workerTemplateTail.
                    await this.handleSv1BridgeUpdate(update).catch(error => {
                        console.error(`Unable to load SV1 bridge update: ${error.message}`);
                    });
                });
                if (typeof this.redisMessagingService.subscribeSv1PrestageUpdates === 'function') {
                    await this.redisMessagingService.subscribeSv1PrestageUpdates(async update => {
                        this.handleSv1PrestageUpdate(update);
                    });
                }
                await this.redisMessagingService.subscribeBlockTemplateUpdates(async update => {
                    this.workerTemplateTail = this.workerTemplateTail
                        .then(() => this.loadTemplateUpdateForWorker(update))
                        .catch(error => console.error(`Unable to load block template update: ${error.message}`));
                    await this.workerTemplateTail;
                });
            }
            await this.redisMessagingService.subscribeMiningInfoUpdates(async (miningInfo: IMiningInfo) => {
                this.miningInfo = miningInfo;
                if (process.env.API_ONLY !== 'true') {
                    // Compatibility with a rolling deployment whose master still
                    // publishes only mining-info.updated and the legacy height key.
                    this.workerTemplateTail = this.workerTemplateTail
                        .then(() => this.loadTemplateForWorker(miningInfo.blocks, 'solo'))
                        .catch(error => console.error(`Unable to load legacy template update: ${error.message}`));
                    await this.workerTemplateTail;
                }
            });
            if (process.env.API_ONLY !== 'true') {
                // Subscribe to every live channel before replaying durable state,
                // closing the old-master/new-worker startup race.
                this.workerTemplateTail = this.workerTemplateTail.then(async () => {
                    // Bridges are transient acceleration messages, not durable
                    // state. Replaying one before canonical work can briefly put a
                    // restarting worker on an orphan; load only authoritative jobs.
                    await this.loadLatestTemplateForWorker();
                    if (typeof this.redisMessagingService.getLatestSv1PrestageUpdates === 'function') {
                        for (const update of await this.redisMessagingService.getLatestSv1PrestageUpdates()) {
                            this.handleSv1PrestageUpdate(update);
                        }
                    }
                });
                await this.workerTemplateTail;
            }
            if (process.env.API_ONLY == 'true') {
                console.log('API-only process using Redis mining info replay');
            }
            return;
        } else {
            this.callRpc('getrpcinfo').then((res) => {
                console.log('Bitcoin RPC connected');
            }, () => {
                console.error('Could not reach RPC host');
            });

            this.miningInfo = await this.getMiningInfo();
            this.validateConfiguredNetworkAgainstCore(this.miningInfo.chain);
            console.log('Using ZMQ');
            const sock = new zmq.Subscriber;

            sock.connectTimeout = 1000;
            sock.events.on('connect', () => {
                console.log('ZMQ Connected');
            });
            sock.events.on('connect:retry', () => {
                console.error('ZMQ Unable to connect, Retrying');
            });

            const zmqTopics = (this.configService.get<string>('BITCOIN_ZMQ_TOPIC')
                ?? process.env.BITCOIN_ZMQ_TOPIC
                ?? 'hashblock')
                .split(',')
                .map(topic => topic.trim())
                .filter(topic => topic.length > 0);
            if (zmqTopics.length === 0) {
                zmqTopics.push('hashblock');
            }
            sock.connect(this.configService.get('BITCOIN_ZMQ_HOST'));
            zmqTopics.forEach(topic => sock.subscribe(topic));
            console.log(`ZMQ subscribed to ${zmqTopics.join(',')}`);
            // Don't await this, otherwise it will block the rest of the program
            this.listenForNewBlocks(sock);

            await this.getAndBroadcastLatestTemplate('startup');
            void this.listenForLongpollTemplates();
            this.auxiliaryTemplateSources.forEach(source => {
                void this.listenForLongpollTemplates(source);
            });

            // Between new blocks we want refresh jobs with the latest transactions
            this.resetTemplateInterval$.pipe(
                startWith(null),
                switchMap(() =>interval(60000))
            ).subscribe(() =>{
                void this.getAndBroadcastLatestTemplate('periodic').catch(error => {
                    console.error(`Periodic block template refresh failed: ${error.message}`);
                });
            });

        }

    }

    private async loadLatestMiningInfoForReplayProcess() {
        const latestMiningInfo = await this.redisMessagingService.getLatestMiningInfo();
        if (latestMiningInfo != null) {
            this.miningInfo = latestMiningInfo;
        }
    }

    private async listenForNewBlocks(sock: zmq.Subscriber) {
        for await (const [topic, msg] of sock) {
            const sourceNotificationReceivedAtMs = Date.now();
            console.log("New Block");
            const miningInfoRefresh = this.getMiningInfo();
            try {
                await this.getAndBroadcastLatestTemplate('new_block', undefined, sourceNotificationReceivedAtMs);
            } catch (error) {
                console.error(`ZMQ block template refresh failed: ${error.message}`);
                continue;
            }
            const refreshedMiningInfo = await miningInfoRefresh;
            if (refreshedMiningInfo != null && refreshedMiningInfo.blocks >= (this.miningInfo?.blocks ?? 0)) {
                this.miningInfo = refreshedMiningInfo;
                // Never wake pre-channel workers until their compatibility
                // template has been written. If it is already ready, refresh
                // their mining-info payload now as well.
                if (this.latestLegacyReadyTipKey === this.lastPublishedTipKey) {
                    void this.redisMessagingService.setLatestMiningInfo(refreshedMiningInfo)
                        .then(() => this.redisMessagingService.publishMiningInfoUpdate(refreshedMiningInfo))
                        .catch(error => console.error(`Unable to refresh mining info: ${error.message}`));
                }
            }

            //Reset the block update interval
            this.resetTemplateInterval$.next();
        }
    }

    public async getAndBroadcastLatestTemplate(
        reason: TemplateRefreshReason = 'periodic',
        longpollId?: string,
        sourceNotificationReceivedAtMs?: number,
    ) {
        if (reason === 'periodic') {
            if (this.periodicTemplateRefresh != null) {
                await this.periodicTemplateRefresh;
                return;
            }
            const refresh = this.getAndBroadcastLatestTemplateOnce(reason, longpollId, sourceNotificationReceivedAtMs);
            this.periodicTemplateRefresh = refresh.finally(() => {
                this.periodicTemplateRefresh = null;
            });
            await this.periodicTemplateRefresh;
            return;
        }
        await this.getAndBroadcastLatestTemplateOnce(reason, longpollId, sourceNotificationReceivedAtMs);
    }

    private async getAndBroadcastLatestTemplateOnce(
        reason: TemplateRefreshReason,
        longpollId?: string,
        sourceNotificationReceivedAtMs?: number,
        templateSource?: TemplateRpcSource,
    ): Promise<void> {
        if (this.miningInfo?.blocks == null) {
            console.warn('Skipping block template broadcast because mining info is not available');
            return;
        }

        const trace = this.startTrace(
            reason,
            sourceNotificationReceivedAtMs,
            templateSource?.name ?? 'primary',
        );
        const blockTemplate = await this.fetchBlockTemplate(trace, longpollId, templateSource);
        if (blockTemplate == null) {
            console.warn(`Skipping block template broadcast for height ${this.miningInfo.blocks}; block template is not available`);
            return;
        }
        if (templateSource != null
            && !await this.isAuxiliaryTemplateAuthorizedByPrimary(blockTemplate, templateSource)) {
            return;
        }

        const tipKey = `${blockTemplate.height}:${blockTemplate.previousblockhash}`;
        const canInterruptPublicationTail = tipKey !== this.lastPublishedTipKey
            && blockTemplate.height > Math.max(
                this.lastPublishedCandidateHeight,
                this.highestUrgentCandidateHeight,
            );
        let urgentBridgeHandled = false;
        if (canInterruptPublicationTail) {
            // Reserve synchronously. Two racing Core sources at the same height
            // must not announce conflicting prevhashes before canonical reorg
            // verification has selected one of them.
            this.highestUrgentCandidateHeight = blockTemplate.height;
            this.markTrace(trace, 'template_ready');
            this.logSourceNotification(trace, blockTemplate);
            urgentBridgeHandled = await this.publishUrgentSubsidyBridges(blockTemplate, trace)
                !== 'failed';
        }

        const publication = this.templatePublicationTail.then(() =>
            this.publishFetchedBlockTemplate(
                blockTemplate,
                reason,
                trace,
                urgentBridgeHandled,
            ),
        );
        this.templatePublicationTail = publication.catch(error => {
            console.error(`Unable to publish fetched block template: ${error.message}`);
        });
        await publication;
    }

    private async publishFetchedBlockTemplate(
        blockTemplate: IBlockTemplate,
        reason: TemplateRefreshReason,
        trace: BlockNotificationTrace,
        urgentBridgeHandled = false,
    ): Promise<void> {
        const tipHeight = blockTemplate.height - 1;
        const tipKey = `${blockTemplate.height}:${blockTemplate.previousblockhash}`;
        const isConflictingTip = this.lastPublishedTipKey != null
            && tipKey !== this.lastPublishedTipKey;
        const requiresBestHashVerification = isConflictingTip
            && (blockTemplate.height <= this.lastPublishedCandidateHeight
                || this.reorgVerificationFenceHeight >= 0);
        let verifiedTipTransition = false;
        if (requiresBestHashVerification) {
            let bestBlockHash: string;
            try {
                bestBlockHash = await this.callRpc<string>('getbestblockhash');
            } catch (error) {
                console.warn(
                    `Refusing unverified non-forward template ${tipKey}: ${error.message ?? error}`,
                );
                return;
            }
            if (bestBlockHash !== blockTemplate.previousblockhash) {
                console.warn(
                    `Ignoring stale non-forward template ${tipKey}; Core best block is ${bestBlockHash}`,
                );
                return;
            }
            verifiedTipTransition = true;
        }
        const isNewTip = tipKey !== this.lastPublishedTipKey;
        this.miningInfo = { ...this.miningInfo, blocks: tipHeight };
        if (!urgentBridgeHandled) {
            this.markTrace(trace, 'template_ready');
        }
        if (isNewTip && !urgentBridgeHandled) {
            this.logSourceNotification(trace, blockTemplate);
        }

        if (isNewTip && !urgentBridgeHandled) {
            // Yield until the urgent Redis socket acknowledges the compact jobs,
            // but enforce a tiny budget so degraded Redis cannot hold canonical
            // storage indefinitely. This guarantees that full-body hashing and
            // JSON serialization do not occupy the same event-loop tick before
            // the bridge command has had an opportunity to leave the process.
            await this.publishUrgentSubsidyBridges(blockTemplate, trace);
        }

        const templateSignature = this.createTemplateSignature(blockTemplate);
        if (templateSignature === this.lastPublishedTemplateSignature) {
            return;
        }

        const soloTemplate: IBlockTemplate = {
            ...blockTemplate,
            payoutMode: 'solo',
            payoutSnapshotId: undefined,
            payoutOutputs: undefined,
            forceCleanJobs: isNewTip,
            jobType: 'full',
            notificationEventId: trace.eventId,
            sourceNotificationReceivedAtMs: trace.sourceNotificationReceivedAtMs,
            notificationPublishedAtMs: Date.now(),
        };

        await this.redisMessagingService.setBlockTemplate(tipHeight, soloTemplate);
        this.markTrace(trace, 'redis_template_stored');
        await Promise.all([
            this.publishBlockTemplateUpdate(soloTemplate, trace.eventId),
        ]);
        this.markTrace(trace, 'workers_notified');

        // The master has no Stratum listeners. Emitting here used to synchronously
        // parse every transaction twice before Redis workers could even begin.
        if (process.env.MASTER !== 'true') {
            this.emitCanonicalTemplate(soloTemplate);
        }

        const priorCandidateHeight = this.lastPublishedCandidateHeight;
        if (verifiedTipTransition && blockTemplate.height <= priorCandidateHeight) {
            this.reorgVerificationFenceHeight = Math.max(
                this.reorgVerificationFenceHeight,
                this.highestPublishedCandidateHeight,
                priorCandidateHeight,
            );
        }
        this.lastPublishedTemplateSignature = templateSignature;
        this.lastPublishedTipKey = tipKey;
        this.lastPublishedCandidateHeight = blockTemplate.height;
        this.highestPublishedCandidateHeight = Math.max(
            this.highestPublishedCandidateHeight,
            blockTemplate.height,
        );
        if (verifiedTipTransition
            && this.reorgVerificationFenceHeight >= 0
            && blockTemplate.height > this.reorgVerificationFenceHeight) {
            this.reorgVerificationFenceHeight = -1;
        }
        this.queueTemplatePersistence(tipHeight, [soloTemplate], trace);
        this.queuePplnsSubsidyBridgeSeedPrecompute(blockTemplate);
        void this.publishNextHeightPrestage(blockTemplate, 'solo').catch(error => {
            console.error(`Unable to publish next-height solo prestage: ${error.message}`);
        });
        this.queuePplnsTemplatePublication({
            blockTemplate,
            soloTemplate,
            tipHeight,
            forceCleanJobs: isNewTip,
            tipKey,
            templateSignature,
            trace,
        });
        this.logTrace(trace, soloTemplate);
    }

    private createTemplateSignature(blockTemplate: IBlockTemplate): string {
        const transactionBodyChecksum = crypto.createHash('sha256');
        const lengthFrame = Buffer.allocUnsafe(4);
        const updateFrame = (value: string, field: string, encoding: BufferEncoding = 'utf8') => {
            if (typeof value !== 'string') {
                throw new Error(`${field} must be a string`);
            }
            if (encoding === 'hex' && (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value))) {
                throw new Error(`${field} must be valid hexadecimal`);
            }
            const byteLength = encoding === 'hex'
                ? value.length / 2
                : Buffer.byteLength(value, encoding);
            lengthFrame.writeUInt32BE(byteLength, 0);
            transactionBodyChecksum.update(lengthFrame);
            transactionBodyChecksum.update(value, encoding);
        };

        blockTemplate.transactions.forEach((transaction, index) => {
            updateFrame(transaction.txid, `transactions[${index}].txid`);
            updateFrame(transaction.hash ?? '', `transactions[${index}].hash`);
            updateFrame(transaction.data, `transactions[${index}].data`, 'hex');
        });

        return [
            blockTemplate.height,
            blockTemplate.previousblockhash,
            blockTemplate.version,
            blockTemplate.bits,
            blockTemplate.mintime,
            blockTemplate.curtime,
            blockTemplate.coinbasevalue,
            blockTemplate.vbrequired,
            blockTemplate.default_witness_commitment,
            blockTemplate.transactions.length,
            transactionBodyChecksum.digest('hex'),
        ].join(':');
    }

    private async loadLatestTemplateForWorker() {
        const [latestMiningInfo, latestBlockTemplates] = await Promise.all([
            this.redisMessagingService.getLatestMiningInfo(),
            this.redisMessagingService.getLatestBlockTemplates(),
        ]);
        if (latestMiningInfo != null) {
            this.miningInfo = latestMiningInfo;
        }

        const expectedLegacyCandidateHeight = latestMiningInfo?.blocks == null
            ? null
            : latestMiningInfo.blocks + 1;
        const pointerByMode = new Map<'solo' | 'pplns', IBlockTemplate>();
        for (const template of latestBlockTemplates) {
            const modes: Array<'solo' | 'pplns'> = template.payoutMode === 'solo'
                ? ['solo']
                : template.payoutMode === 'pplns'
                    ? ['pplns']
                    : ['solo', 'pplns'];
            for (const mode of modes) {
                const existing = pointerByMode.get(mode);
                if (existing == null
                    || template.height > existing.height
                    || (template.height === existing.height
                        && (template.notificationPublishedAtMs ?? 0)
                            >= (existing.notificationPublishedAtMs ?? 0))) {
                    pointerByMode.set(mode, template);
                }
            }
        }

        const selectedByMode = new Map<'solo' | 'pplns', IBlockTemplate>();
        for (const mode of ['solo', 'pplns'] as const) {
            const pointer = pointerByMode.get(mode);
            if (pointer != null
                && (expectedLegacyCandidateHeight == null
                    || pointer.height >= expectedLegacyCandidateHeight)) {
                selectedByMode.set(mode, pointer);
                continue;
            }

            const legacyCandidates = latestMiningInfo?.blocks == null
                ? []
                : await this.readTemplatesForWorker(latestMiningInfo.blocks, mode);
            const legacy = legacyCandidates.reduce<IBlockTemplate | null>((newest, candidate) => (
                newest == null
                    || candidate.height > newest.height
                    || (candidate.height === newest.height
                        && (candidate.notificationPublishedAtMs ?? 0)
                            >= (newest.notificationPublishedAtMs ?? 0))
                    ? candidate
                    : newest
            ), null);
            if (pointer != null && this.isPointerPreferredForReplay(pointer, legacy)) {
                selectedByMode.set(mode, pointer);
            } else if (legacy != null) {
                selectedByMode.set(mode, legacy);
            } else if (pointer != null) {
                selectedByMode.set(mode, pointer);
            }
        }

        const replayTemplates = [...new Map(
            [...selectedByMode.values()].map(template => [
                this.getCanonicalEmissionSignature(template),
                template,
            ]),
        ).values()].sort((left, right) => (
            left.height - right.height
            || (left.notificationPublishedAtMs ?? 0) - (right.notificationPublishedAtMs ?? 0)
        ));
        for (const template of replayTemplates) {
            this.emitCanonicalTemplate(template);
        }
    }

    private isPointerPreferredForReplay(
        pointer: IBlockTemplate,
        legacy: IBlockTemplate | null,
    ): boolean {
        if (legacy == null || pointer.height > legacy.height) {
            return true;
        }
        if (pointer.height < legacy.height) {
            return pointer.notificationPublishedAtMs != null
                && (legacy.notificationPublishedAtMs == null
                    || pointer.notificationPublishedAtMs > legacy.notificationPublishedAtMs);
        }
        if (pointer.notificationPublishedAtMs == null) {
            return legacy.notificationPublishedAtMs == null;
        }
        return legacy.notificationPublishedAtMs == null
            || pointer.notificationPublishedAtMs >= legacy.notificationPublishedAtMs;
    }

    private async loadTemplateUpdateForWorker(update: BlockTemplateUpdate): Promise<void> {
        if (this.processedTemplateEvents.has(update.eventId)) {
            return;
        }
        this.rememberProcessedTemplateEvent(update.eventId);
        await this.loadTemplateForWorker(
            update.height,
            update.payoutMode,
            update.previousBlockHash,
            update.publishedAtMs,
        );
    }

    private async loadTemplateForWorker(
        blockHeight: number,
        payoutMode: 'solo' | 'pplns' = 'solo',
        previousBlockHash?: string,
        publishedAtMs?: number,
    ) {
        for (const template of await this.readTemplatesForWorker(
            blockHeight,
            payoutMode,
            previousBlockHash,
            publishedAtMs,
        )) {
            this.emitCanonicalTemplate(template);
        }
    }

    private async readTemplatesForWorker(
        blockHeight: number,
        payoutMode: 'solo' | 'pplns' = 'solo',
        previousBlockHash?: string,
        publishedAtMs?: number,
    ): Promise<IBlockTemplate[]> {
        const redisBlockTemplate = await this.redisMessagingService.getBlockTemplate(
            blockHeight,
            payoutMode,
            previousBlockHash,
        );
        if (redisBlockTemplate != null) {
            return [{
                ...redisBlockTemplate,
                notificationPublishedAtMs: publishedAtMs ?? redisBlockTemplate.notificationPublishedAtMs,
            }];
        }

        const savedBlockTemplate = await this.rpcBlockService.getSavedBlockTemplate(blockHeight);
        if (savedBlockTemplate?.data != null) {
            return this.parseStoredBlockTemplates(savedBlockTemplate.data)
                .filter(template => template.payoutMode == null
                    || template.payoutMode === 'all'
                    || template.payoutMode === payoutMode);
        }
        return [];
    }

    private async fetchBlockTemplate(
        trace: BlockNotificationTrace,
        longpollId?: string,
        templateSource?: TemplateRpcSource,
    ) {

        console.log(`Master fetching block template after tip ${this.miningInfo?.blocks}`);

        let blockTemplate: IBlockTemplate;
        let retryDelayMs = this.getPositiveIntegerEnv('BLOCK_TEMPLATE_RETRY_INITIAL_MS', 25);
        const maxRetryDelayMs = this.getPositiveIntegerEnv('BLOCK_TEMPLATE_RETRY_MAX_MS', 1000);
        while (blockTemplate == null) {
            try {
                blockTemplate = await this.callRpcWithClient<IBlockTemplate>(
                    templateSource?.client ?? this.client,
                    'getblocktemplate', [
                    {
                        rules: ['segwit'],
                        mode: 'template',
                        capabilities: ['serverlist', 'proposal'],
                        ...(longpollId == null ? {} : { longpollid: longpollId }),
                    }
                ], longpollId == null
                    ? undefined
                    : this.getPositiveIntegerEnv('BLOCK_TEMPLATE_LONGPOLL_TIMEOUT_MS', 10 * 60 * 1000));
            } catch (e) {
                console.warn(`Block template is not available yet: ${e.message ?? e}`);
                await new Promise(resolve => setTimeout(resolve, retryDelayMs));
                retryDelayMs = Math.min(maxRetryDelayMs, retryDelayMs * 2);
            }
        }
        if (trace.reason === 'longpoll') {
            const waitMs = Number(process.hrtime.bigint() - trace.startedMonotonic) / 1e6;
            const sourceNotificationReceivedAtMs = Date.now();
            trace.sourceNotificationReceivedAtMs = sourceNotificationReceivedAtMs;
            trace.startedWallMs = sourceNotificationReceivedAtMs;
            trace.startedMonotonic = process.hrtime.bigint();
            trace.stages = { start: 0, longpollWait: waitMs };
        } else {
            this.markTrace(trace, 'getblocktemplate_complete');
        }
        if (templateSource == null) {
            this.latestLongpollId = blockTemplate.longpollid;
        } else {
            templateSource.latestLongpollId = blockTemplate.longpollid;
        }

        return blockTemplate;
    }

    private async listenForLongpollTemplates(templateSource?: TemplateRpcSource): Promise<void> {
        if (process.env.MASTER !== 'true') {
            return;
        }
        if (templateSource == null) {
            if (this.longpollLoopStarted) {
                return;
            }
            this.longpollLoopStarted = true;
        } else {
            if (templateSource.longpollLoopStarted) {
                return;
            }
            templateSource.longpollLoopStarted = true;
        }

        while (process.env.MASTER === 'true') {
            const longpollId = templateSource == null
                ? this.latestLongpollId
                : templateSource.latestLongpollId;
            if (longpollId == null) {
                try {
                    await this.getAndBroadcastLatestTemplateOnce(
                        'startup',
                        undefined,
                        undefined,
                        templateSource,
                    );
                } catch (error) {
                    console.error(
                        `Block template source ${templateSource?.name ?? 'primary'} startup failed: ${error.message}`,
                    );
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
                continue;
            }
            try {
                if (templateSource == null) {
                    await this.getAndBroadcastLatestTemplate('longpoll', longpollId);
                } else {
                    await this.getAndBroadcastLatestTemplateOnce(
                        'longpoll',
                        longpollId,
                        undefined,
                        templateSource,
                    );
                }
            } catch (error) {
                console.error(
                    `Block template longpoll failed for ${templateSource?.name ?? 'primary'}: ${error.message}`,
                );
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    private queuePplnsTemplatePublication(
        pending: PendingPplnsTemplatePublication,
    ): void {
        const preserveCleanSwitch = [
            this.activePplnsTemplatePublication,
            this.pendingPplnsTemplatePublication,
        ].some(publication => (
            publication?.tipKey === pending.tipKey
            && publication.forceCleanJobs
        ));
        this.pendingPplnsTemplatePublication = {
            ...pending,
            forceCleanJobs: pending.forceCleanJobs || preserveCleanSwitch,
        };
        if (this.pplnsTemplatePublicationPromise != null) {
            return;
        }
        this.pplnsTemplatePublicationPromise = this.drainPplnsTemplatePublications()
            .catch(error => {
                console.error(`Unable to publish PPLNS template: ${error.message}`);
            })
            .finally(() => {
                this.pplnsTemplatePublicationPromise = null;
                if (this.pendingPplnsTemplatePublication != null) {
                    this.queuePplnsTemplatePublication(this.pendingPplnsTemplatePublication);
                }
            });
    }

    private async drainPplnsTemplatePublications(): Promise<void> {
        while (this.pendingPplnsTemplatePublication != null) {
            const pending = this.pendingPplnsTemplatePublication;
            this.pendingPplnsTemplatePublication = null;
            this.activePplnsTemplatePublication = pending;
            try {
                await this.createAndPublishPplnsTemplate(
                    pending.blockTemplate,
                    pending.soloTemplate,
                    pending.tipHeight,
                    pending.forceCleanJobs,
                    pending.tipKey,
                    pending.templateSignature,
                    pending.trace,
                );
            } finally {
                this.activePplnsTemplatePublication = null;
            }
        }
    }

    private async createAndPublishPplnsTemplate(
        blockTemplate: IBlockTemplate,
        soloTemplate: IBlockTemplate,
        tipHeight: number,
        forceCleanJobs: boolean,
        tipKey: string,
        templateSignature: string,
        trace: BlockNotificationTrace,
    ): Promise<void> {
        const legacyRequiresPplns = this.hasConfiguredPplnsListeners();
        let legacyTemplate: IBlockTemplate | null = legacyRequiresPplns
            ? null
            : soloTemplate;
        try {
            const payoutSnapshot = await this.payoutSnapshotService?.createSnapshotForTemplate({
                blockHeight: blockTemplate.height,
                coinbaseValueSats: blockTemplate.coinbasevalue,
                networkDifficulty: this.calculateNetworkDifficulty(parseInt(blockTemplate.bits, 16)),
            });
            this.markTrace(trace, 'payout_snapshot_complete');
            if (payoutSnapshot == null) {
                return;
            }
            if (typeof payoutSnapshot.id !== 'string'
                || payoutSnapshot.id.trim().length === 0
                || !Array.isArray(payoutSnapshot.payoutOutputs)
                || payoutSnapshot.payoutOutputs.length === 0) {
                console.error(
                    `PPLNS snapshot for ${tipKey} has no usable payout outputs; skipping PPLNS publication`,
                );
                return;
            }
            if (this.lastPublishedTipKey !== tipKey
                || this.lastPublishedTemplateSignature !== templateSignature) {
                console.warn(`Discarding superseded PPLNS snapshot for ${tipKey}`);
                return;
            }

            const pplnsTemplate: IBlockTemplate = {
                ...blockTemplate,
                payoutMode: 'pplns',
                payoutSnapshotId: payoutSnapshot.id,
                payoutOutputs: payoutSnapshot.payoutOutputs,
                forceCleanJobs,
                jobType: 'full',
                notificationEventId: `${trace.eventId}:pplns`,
                sourceNotificationReceivedAtMs: trace.sourceNotificationReceivedAtMs,
                notificationPublishedAtMs: Date.now(),
            };
            legacyTemplate = pplnsTemplate;
            await this.redisMessagingService.setBlockTemplate(tipHeight, pplnsTemplate);
            this.markTrace(trace, 'pplns_template_stored');
            await this.publishBlockTemplateUpdate(pplnsTemplate, `${trace.eventId}:pplns`);
            this.markTrace(trace, 'pplns_workers_notified');
            this.queueTemplatePersistence(tipHeight, [soloTemplate, pplnsTemplate], trace);
            this.logTrace(trace, pplnsTemplate);
        } catch (e) {
            console.error('Error creating or publishing payout snapshot template', e);
        } finally {
            // Pre-channel workers understand one template per height. Publish a
            // PPLNS-populated template when available (solo clients ignore those
            // outputs), and only then wake them through mining-info.updated.
            if (this.lastPublishedTipKey === tipKey
                && this.lastPublishedTemplateSignature === templateSignature) {
                if (legacyTemplate == null) {
                    this.markTrace(trace, 'legacy_workers_held_for_pplns');
                    console.warn(
                        `Holding legacy workers on prior work for ${tipKey}; a safe PPLNS compatibility template is unavailable`,
                    );
                    return;
                }
                try {
                    await this.redisMessagingService.setLegacyBlockTemplate(tipHeight, legacyTemplate);
                    this.latestLegacyReadyTipKey = tipKey;
                    await this.redisMessagingService.setLatestMiningInfo(this.miningInfo);
                    await this.redisMessagingService.publishMiningInfoUpdate(this.miningInfo);
                    this.markTrace(trace, 'legacy_workers_notified');
                } catch (error) {
                    console.error(`Unable to publish legacy template compatibility update: ${error.message}`);
                }
            }
        }
    }

    private async publishBlockTemplateUpdate(blockTemplate: IBlockTemplate, eventId: string): Promise<void> {
        await this.redisMessagingService.publishBlockTemplateUpdate({
            schemaVersion: 1,
            eventId,
            height: blockTemplate.height - 1,
            previousBlockHash: blockTemplate.previousblockhash,
            payoutMode: blockTemplate.payoutMode === 'pplns' ? 'pplns' : 'solo',
            publishedAtMs: blockTemplate.notificationPublishedAtMs ?? Date.now(),
        });
    }

    private async publishUrgentSubsidyBridges(
        authoritativeTemplate: IBlockTemplate,
        trace: BlockNotificationTrace,
    ): Promise<UrgentBridgePublishResult> {
        const startedAt = Date.now();
        this.markTrace(trace, 'sv1_bridge_publish_started');
        const publication = Promise.all([
            // The compact activation is enqueued before any compatibility bridge.
            this.publishSoloUrgentWork(authoritativeTemplate, trace, 'urgent'),
            this.publishPplnsUrgentWork(authoritativeTemplate, trace, 'urgent'),
        ]);
        const budgetMs = this.getPositiveIntegerEnv(
            'SV1_BRIDGE_PUBLISH_BUDGET_MS',
            DEFAULT_SV1_BRIDGE_PUBLISH_BUDGET_MS,
        );
        let timeout: NodeJS.Timeout | null = null;
        const result = await Promise.race([
            publication.then(results => ({ timedOut: false as const, results })),
            new Promise<{ timedOut: true; results?: never }>(resolve => {
                timeout = setTimeout(() => resolve({ timedOut: true }), budgetMs);
            }),
        ]);
        if (timeout != null) {
            clearTimeout(timeout);
        }

        if (result.timedOut) {
            this.markTrace(trace, 'sv1_bridge_publish_budget_exhausted');
            console.warn(JSON.stringify({
                event: 'sv1_bridge_publish_budget_exhausted',
                eventId: trace.eventId,
                budgetMs,
                elapsedMs: Date.now() - startedAt,
                templateHeight: authoritativeTemplate.height,
                previousBlockHash: authoritativeTemplate.previousblockhash,
            }));
            // The urgent socket may be stuck rather than merely slow. Release
            // only this attempt's reservations and immediately retry through the
            // independent normal command socket. Duplicate delivery is safe: the
            // envelope event id is identical and workers de-duplicate it.
            this.releaseBridgeReservations(authoritativeTemplate);
            void this.publishFallbackSubsidyBridges(authoritativeTemplate, trace, publication);
            return 'fallback-started';
        }
        if (result.results.includes('failed')) {
            this.markTrace(trace, 'sv1_bridge_publish_failed');
            return 'failed';
        }
        this.markTrace(trace, 'sv1_bridge_publish_acknowledged');
        return 'acknowledged';
    }

    private async publishFallbackSubsidyBridges(
        authoritativeTemplate: IBlockTemplate,
        trace: BlockNotificationTrace,
        originalPublication: Promise<BridgePublishResult[]>,
    ): Promise<void> {
        // Observe the original attempt even if it rejects unexpectedly.
        void originalPublication.catch(error => {
            console.error(`Urgent SV1 bridge publication failed after timeout: ${error.message}`);
        });
        const results = await Promise.all([
            this.publishSoloUrgentWork(authoritativeTemplate, trace, 'fallback'),
            this.publishPplnsUrgentWork(authoritativeTemplate, trace, 'fallback'),
        ]);
        if (results.includes('failed')) {
            this.markTrace(trace, 'sv1_bridge_fallback_failed');
            console.error(JSON.stringify({
                event: 'sv1_bridge_fallback_failed',
                eventId: trace.eventId,
                templateHeight: authoritativeTemplate.height,
                previousBlockHash: authoritativeTemplate.previousblockhash,
                results,
            }));
            return;
        }
        this.markTrace(trace, 'sv1_bridge_fallback_acknowledged');
    }

    private releaseBridgeReservations(authoritativeTemplate: IBlockTemplate): void {
        const tipKey = `${authoritativeTemplate.height}:${authoritativeTemplate.previousblockhash}`;
        for (const payoutMode of ['solo', 'pplns'] as const) {
            if (this.lastPublishedBridgeTipKeys.get(payoutMode)?.tipKey === tipKey) {
                this.lastPublishedBridgeTipKeys.delete(payoutMode);
            }
            if (this.lastPublishedActivationTipKeys.get(payoutMode)?.tipKey === tipKey) {
                this.lastPublishedActivationTipKeys.delete(payoutMode);
            }
        }
    }

    private async publishSoloUrgentWork(
        authoritativeTemplate: IBlockTemplate,
        trace: BlockNotificationTrace,
        lane: 'urgent' | 'fallback',
    ): Promise<BridgePublishResult> {
        const activation = await this.publishPrestageActivation(
            authoritativeTemplate,
            trace,
            'solo',
            lane,
        );
        if (activation === 'published') {
            if (this.isSv1CompatibilityBridgeEnabled()) {
                void this.publishSoloSubsidyBridge(authoritativeTemplate, trace, lane);
            }
            return 'published';
        }
        return this.publishSoloSubsidyBridge(authoritativeTemplate, trace, lane);
    }

    private async publishPplnsUrgentWork(
        authoritativeTemplate: IBlockTemplate,
        trace: BlockNotificationTrace,
        lane: 'urgent' | 'fallback',
    ): Promise<BridgePublishResult> {
        const activation = await this.publishPrestageActivation(
            authoritativeTemplate,
            trace,
            'pplns',
            lane,
        );
        if (activation === 'published') {
            if (this.isSv1CompatibilityBridgeEnabled()) {
                void this.publishPplnsSubsidyBridge(authoritativeTemplate, trace, lane);
            }
            return 'published';
        }
        return this.publishPplnsSubsidyBridge(authoritativeTemplate, trace, lane);
    }

    private async publishPrestageActivation(
        authoritativeTemplate: IBlockTemplate,
        trace: BlockNotificationTrace,
        payoutMode: 'solo' | 'pplns',
        lane: 'urgent' | 'fallback',
    ): Promise<BridgePublishResult> {
        if (!this.isSv1CompactActivationEnabled()
            || !this.isSv1SubsidyBridgeEnabled()
            || !this.getSv1SubsidyBridgePayoutModes().has(payoutMode)
            || typeof this.redisMessagingService.publishSv1PrestageActivation !== 'function') {
            return 'skipped';
        }

        let subsidySats: number;
        try {
            subsidySats = this.validateSubsidyAgainstAuthoritativeTemplate(
                authoritativeTemplate,
            );
        } catch (error) {
            console.error(`Skipping ${payoutMode} SV1 prestage activation: ${error.message}`);
            return 'failed';
        }
        let payoutSnapshotId: string | undefined;
        if (payoutMode === 'pplns') {
            const seed = this.getFreshPplnsSubsidyBridgeSeed(authoritativeTemplate.height);
            if (seed == null
                || seed.subsidySats !== subsidySats
                || seed.basisBits.toLowerCase() !== authoritativeTemplate.bits.toLowerCase()) {
                return 'skipped';
            }
            payoutSnapshotId = seed.payoutSnapshotId;
        }

        const tipKey = `${authoritativeTemplate.height}:${authoritativeTemplate.previousblockhash}`;
        if (this.lastPublishedActivationTipKeys.get(payoutMode)?.tipKey === tipKey) {
            return 'skipped';
        }
        const reservation: BridgePublishReservation = {
            tipKey,
            attemptId: ++this.bridgePublishAttemptId,
        };
        this.lastPublishedActivationTipKeys.set(payoutMode, reservation);

        try {
            const publishedAtMs = Date.now();
            const activation: Sv1PrestageActivation = {
                schemaVersion: 1,
                type: 'prestage-activation',
                eventId: `${trace.eventId}:activate:${payoutMode}`,
                height: authoritativeTemplate.height,
                previousBlockHash: authoritativeTemplate.previousblockhash.toLowerCase(),
                version: authoritativeTemplate.version,
                bits: authoritativeTemplate.bits.toLowerCase(),
                minTime: authoritativeTemplate.mintime,
                currentTime: authoritativeTemplate.curtime,
                subsidySats,
                payoutMode,
                ...(payoutSnapshotId == null ? {} : { payoutSnapshotId }),
                requiredVersionBits: authoritativeTemplate.vbrequired >>> 0,
                sourceNotificationReceivedAtMs: trace.sourceNotificationReceivedAtMs,
                publishedAtMs,
            };
            const delivered = lane === 'urgent'
                ? await this.redisMessagingService.publishSv1PrestageActivation(activation)
                : await this.redisMessagingService.publishSv1PrestageActivation(
                    activation,
                    'fallback',
                );
            if (!delivered) {
                throw new Error(`Redis ${lane} prestage activation publisher is unavailable`);
            }
            this.markTrace(trace, `sv1_${payoutMode}_activation_workers_notified`);
            return 'published';
        } catch (error) {
            if (this.lastPublishedActivationTipKeys.get(payoutMode) === reservation) {
                this.lastPublishedActivationTipKeys.delete(payoutMode);
            }
            console.error(`Skipping ${payoutMode} SV1 prestage activation: ${error.message}`);
            return 'failed';
        }
    }

    private async publishSoloSubsidyBridge(
        authoritativeTemplate: IBlockTemplate,
        trace: BlockNotificationTrace,
        lane: 'urgent' | 'fallback' = 'urgent',
    ): Promise<BridgePublishResult> {
        if (!this.isSv1SubsidyBridgeEnabled()
            || !this.getSv1SubsidyBridgePayoutModes().has('solo')) {
            return 'skipped';
        }

        const tipKey = `${authoritativeTemplate.height}:${authoritativeTemplate.previousblockhash}`;
        if (this.lastPublishedBridgeTipKeys.get('solo')?.tipKey === tipKey) {
            return 'skipped';
        }

        // Reserve the tip before the Redis await so duplicate ZMQ/longpoll
        // callbacks cannot launch a second in-flight bridge publication.
        const reservation: BridgePublishReservation = {
            tipKey,
            attemptId: ++this.bridgePublishAttemptId,
        };
        this.lastPublishedBridgeTipKeys.set('solo', reservation);

        try {
            this.validateSubsidyAgainstAuthoritativeTemplate(authoritativeTemplate);
            const bridgeTemplate = createSubsidyOnlyBlockTemplate({
                authoritativeTemplate,
                network: this.getNetworkName(),
                payoutMode: 'solo',
                halvingInterval: this.getOptionalPositiveIntegerEnv('SUBSIDY_HALVING_INTERVAL'),
            });
            bridgeTemplate.mintime = Math.max(
                authoritativeTemplate.mintime,
                authoritativeTemplate.curtime,
                Math.floor(Date.now() / 1000),
            );
            bridgeTemplate.notificationEventId = `${trace.eventId}:bridge`;
            bridgeTemplate.sourceNotificationReceivedAtMs = trace.sourceNotificationReceivedAtMs;
            bridgeTemplate.notificationPreparedAtMs = Date.now();
            const publishedAtMs = Date.now();
            bridgeTemplate.notificationPublishedAtMs = publishedAtMs;
            const update: Sv1BridgeUpdate = {
                schemaVersion: 1,
                type: 'subsidy-bridge',
                eventId: `${trace.eventId}:bridge`,
                template: bridgeTemplate,
                publishedAtMs,
            };
            const delivered = lane === 'urgent'
                ? await this.redisMessagingService.publishSv1BridgeUpdate(update)
                : await this.redisMessagingService.publishSv1BridgeUpdate(update, 'fallback');
            if (!delivered) {
                throw new Error(`Redis ${lane} bridge publisher is unavailable`);
            }
            this.markTrace(trace, 'sv1_bridge_workers_notified');
            return 'published';
        } catch (error) {
            if (this.lastPublishedBridgeTipKeys.get('solo') === reservation) {
                this.lastPublishedBridgeTipKeys.delete('solo');
            }
            console.error(`Skipping SV1 subsidy bridge: ${error.message}`);
            return 'failed';
        }
    }

    private async publishPplnsSubsidyBridge(
        authoritativeTemplate: IBlockTemplate,
        trace: BlockNotificationTrace,
        lane: 'urgent' | 'fallback' = 'urgent',
    ): Promise<BridgePublishResult> {
        if (!this.isSv1SubsidyBridgeEnabled()
            || !this.getSv1SubsidyBridgePayoutModes().has('pplns')) {
            return 'skipped';
        }

        const tipKey = `${authoritativeTemplate.height}:${authoritativeTemplate.previousblockhash}`;
        if (this.lastPublishedBridgeTipKeys.get('pplns')?.tipKey === tipKey) {
            return 'skipped';
        }

        const seed = this.getFreshPplnsSubsidyBridgeSeed(authoritativeTemplate.height);
        if (seed == null) {
            return 'skipped';
        }

        const reservation: BridgePublishReservation = {
            tipKey,
            attemptId: ++this.bridgePublishAttemptId,
        };
        this.lastPublishedBridgeTipKeys.set('pplns', reservation);

        try {
            const expectedSubsidy = this.validateSubsidyAgainstAuthoritativeTemplate(
                authoritativeTemplate,
            );
            if (seed.subsidySats !== expectedSubsidy) {
                throw new Error(
                    `PPLNS bridge seed subsidy ${seed.subsidySats} does not match expected subsidy ${expectedSubsidy}`,
                );
            }
            if (seed.basisBits.toLowerCase() !== authoritativeTemplate.bits.toLowerCase()) {
                throw new Error(
                    `PPLNS bridge seed bits ${seed.basisBits} do not match authoritative bits ${authoritativeTemplate.bits}`,
                );
            }
            const bridgeTemplate = createSubsidyOnlyBlockTemplate({
                authoritativeTemplate,
                network: this.getNetworkName(),
                payoutMode: 'pplns',
                halvingInterval: this.getOptionalPositiveIntegerEnv('SUBSIDY_HALVING_INTERVAL'),
                payoutSnapshot: {
                    id: seed.payoutSnapshotId,
                    payoutOutputs: seed.payoutOutputs,
                },
            });
            bridgeTemplate.mintime = Math.max(
                authoritativeTemplate.mintime,
                authoritativeTemplate.curtime,
                Math.floor(Date.now() / 1000),
            );
            bridgeTemplate.notificationEventId = `${trace.eventId}:bridge:pplns`;
            bridgeTemplate.sourceNotificationReceivedAtMs = trace.sourceNotificationReceivedAtMs;
            bridgeTemplate.payoutBridgeSeedCreatedAtMs = seed.preparedAtMs;
            bridgeTemplate.notificationPreparedAtMs = Date.now();
            const publishedAtMs = Date.now();
            bridgeTemplate.notificationPublishedAtMs = publishedAtMs;
            const update: Sv1BridgeUpdate = {
                schemaVersion: 1,
                type: 'subsidy-bridge',
                eventId: `${trace.eventId}:bridge:pplns`,
                template: bridgeTemplate,
                publishedAtMs,
            };
            const delivered = lane === 'urgent'
                ? await this.redisMessagingService.publishSv1BridgeUpdate(update)
                : await this.redisMessagingService.publishSv1BridgeUpdate(update, 'fallback');
            if (!delivered) {
                throw new Error(`Redis ${lane} bridge publisher is unavailable`);
            }
            this.markTrace(trace, 'sv1_pplns_bridge_workers_notified');
            return 'published';
        } catch (error) {
            if (this.lastPublishedBridgeTipKeys.get('pplns') === reservation) {
                this.lastPublishedBridgeTipKeys.delete('pplns');
            }
            console.error(`Skipping PPLNS SV1 subsidy bridge: ${error.message}`);
            return 'failed';
        }
    }

    private async publishNextHeightPrestage(
        authoritativeTemplate: IBlockTemplate,
        payoutMode: 'solo' | 'pplns',
        seed?: PplnsSubsidyBridgeSeed,
    ): Promise<boolean> {
        if (!this.isSv1SubsidyBridgeEnabled()
            || !this.getSv1SubsidyBridgePayoutModes().has(payoutMode)) {
            return false;
        }

        const candidateHeight = authoritativeTemplate.height + 1;
        const subsidySats = calculateBlockSubsidySats(
            candidateHeight,
            this.getNetworkName(),
            this.getOptionalPositiveIntegerEnv('SUBSIDY_HALVING_INTERVAL'),
        );
        if (payoutMode === 'pplns') {
            if (seed == null
                || seed.candidateHeight !== candidateHeight
                || seed.subsidySats !== subsidySats
                || seed.basisBits.toLowerCase() !== authoritativeTemplate.bits.toLowerCase()) {
                return false;
            }
        }

        const prestageKey = [
            candidateHeight,
            payoutMode,
            subsidySats,
            authoritativeTemplate.bits.toLowerCase(),
            seed?.payoutSnapshotId ?? '',
        ].join(':');
        if (this.lastPublishedPrestageKeys.get(payoutMode) === prestageKey) {
            return false;
        }
        this.lastPublishedPrestageKeys.set(payoutMode, prestageKey);

        try {
            const futureShape: IBlockTemplate = {
                ...authoritativeTemplate,
                height: candidateHeight,
                previousblockhash: '0'.repeat(64),
                transactions: [],
                coinbasevalue: subsidySats,
                longpollid: `prestage:${candidateHeight}:${authoritativeTemplate.bits}`,
                curtime: Math.max(
                    authoritativeTemplate.curtime,
                    Math.floor(Date.now() / 1000),
                ),
                mintime: Math.max(
                    authoritativeTemplate.mintime,
                    authoritativeTemplate.curtime,
                ),
            };
            const template = createSubsidyOnlyBlockTemplate({
                authoritativeTemplate: futureShape,
                network: this.getNetworkName(),
                payoutMode,
                halvingInterval: this.getOptionalPositiveIntegerEnv('SUBSIDY_HALVING_INTERVAL'),
                ...(payoutMode === 'pplns'
                    ? {
                        payoutSnapshot: {
                            id: seed!.payoutSnapshotId,
                            payoutOutputs: seed!.payoutOutputs,
                        },
                    }
                    : {}),
            });
            template.notificationEventId = `prestage:${payoutMode}:${candidateHeight}:${Date.now()}`;
            template.notificationPreparedAtMs = Date.now();
            const update: Sv1PrestageUpdate = {
                schemaVersion: 1,
                type: 'subsidy-prestage',
                eventId: template.notificationEventId,
                template,
                preparedAtMs: template.notificationPreparedAtMs,
            };
            await this.redisMessagingService.publishSv1PrestageUpdate(update);
            return true;
        } catch (error) {
            if (this.lastPublishedPrestageKeys.get(payoutMode) === prestageKey) {
                this.lastPublishedPrestageKeys.delete(payoutMode);
            }
            throw error;
        }
    }

    private queuePplnsSubsidyBridgeSeedPrecompute(
        canonicalTemplate: IBlockTemplate,
    ): void {
        if (!this.isSv1SubsidyBridgeEnabled()
            || !this.getSv1SubsidyBridgePayoutModes().has('pplns')
            || this.payoutSnapshotService == null) {
            return;
        }

        const generation = ++this.pplnsSeedPrecomputeGeneration;
        this.pendingPplnsSeedPrecompute = { template: canonicalTemplate, generation };
        if (this.pplnsSeedPrecomputeRunning) {
            return;
        }
        this.pplnsSeedPrecomputeRunning = true;
        this.pplnsSeedPrecomputeTail = this.drainPplnsSeedPrecompute()
            .catch(error => {
                console.error(`Unable to precompute PPLNS subsidy bridge seed: ${error.message}`);
            })
            .finally(() => {
                this.pplnsSeedPrecomputeRunning = false;
                if (this.pendingPplnsSeedPrecompute != null) {
                    this.queuePplnsSubsidyBridgeSeedPrecompute(
                        this.pendingPplnsSeedPrecompute.template,
                    );
                }
            });
    }

    private async drainPplnsSeedPrecompute(): Promise<void> {
        while (this.pendingPplnsSeedPrecompute != null) {
            const { template, generation } = this.pendingPplnsSeedPrecompute;
            this.pendingPplnsSeedPrecompute = null;
            const candidateHeight = template.height + 1;
            try {
                const subsidySats = calculateBlockSubsidySats(
                    candidateHeight,
                    this.getNetworkName(),
                    this.getOptionalPositiveIntegerEnv('SUBSIDY_HALVING_INTERVAL'),
                );
                const snapshot = await this.payoutSnapshotService.createSnapshotForTemplate({
                    blockHeight: candidateHeight,
                    coinbaseValueSats: subsidySats,
                    networkDifficulty: this.calculateNetworkDifficulty(
                        parseInt(template.bits, 16),
                    ),
                    visibility: 'bridge_seed',
                });
                if (generation !== this.pplnsSeedPrecomputeGeneration) {
                    continue;
                }
                if (snapshot == null) {
                    this.pplnsSubsidyBridgeSeeds.delete(candidateHeight);
                    continue;
                }
                if (snapshot.blockHeight !== candidateHeight
                    || Number(snapshot.coinbaseValueSats) !== subsidySats) {
                    throw new Error(
                        `PPLNS seed snapshot does not match candidate height ${candidateHeight} and subsidy ${subsidySats}`,
                    );
                }
                const payoutOutputs = this.validatePplnsSeedOutputs(
                    snapshot.id,
                    snapshot.payoutOutputs,
                    subsidySats,
                );
                this.storePplnsSubsidyBridgeSeed({
                    candidateHeight,
                    subsidySats,
                    basisBits: template.bits,
                    payoutSnapshotId: snapshot.id,
                    payoutOutputs,
                    preparedAtMs: Date.now(),
                });
                const seed = this.pplnsSubsidyBridgeSeeds.get(candidateHeight);
                if (seed != null) {
                    void this.publishNextHeightPrestage(template, 'pplns', seed).catch(error => {
                        console.error(`Unable to publish next-height PPLNS prestage: ${error.message}`);
                    });
                }
            } catch (error) {
                if (generation === this.pplnsSeedPrecomputeGeneration) {
                    this.pplnsSubsidyBridgeSeeds.delete(candidateHeight);
                }
                console.error(`Unable to precompute PPLNS subsidy bridge seed: ${error.message}`);
            }
        }
    }

    private getFreshPplnsSubsidyBridgeSeed(
        candidateHeight: number,
    ): PplnsSubsidyBridgeSeed | null {
        const seed = this.pplnsSubsidyBridgeSeeds.get(candidateHeight);
        if (seed == null) {
            return null;
        }
        const ageMs = Date.now() - seed.preparedAtMs;
        const maxAgeMs = this.getPositiveIntegerEnv(
            'SV1_SUBSIDY_BRIDGE_PPLNS_SEED_MAX_AGE_MS',
            DEFAULT_PPLNS_BRIDGE_SEED_MAX_AGE_MS,
        );
        if (ageMs < 0 || ageMs > maxAgeMs) {
            this.pplnsSubsidyBridgeSeeds.delete(candidateHeight);
            return null;
        }
        return seed;
    }

    private storePplnsSubsidyBridgeSeed(seed: PplnsSubsidyBridgeSeed): void {
        this.pplnsSubsidyBridgeSeeds.set(seed.candidateHeight, seed);
        const currentHeight = seed.candidateHeight - 1;
        for (const height of this.pplnsSubsidyBridgeSeeds.keys()) {
            if (height < currentHeight || height > seed.candidateHeight) {
                this.pplnsSubsidyBridgeSeeds.delete(height);
            }
        }
    }

    private validatePplnsSeedOutputs(
        payoutSnapshotId: string,
        payoutOutputs: IBlockTemplate['payoutOutputs'],
        subsidySats: number,
    ): NonNullable<IBlockTemplate['payoutOutputs']> {
        if (typeof payoutSnapshotId !== 'string' || payoutSnapshotId.trim().length === 0) {
            throw new Error('PPLNS bridge seed requires a payout snapshot id');
        }
        if (!Array.isArray(payoutOutputs) || payoutOutputs.length === 0) {
            throw new Error('PPLNS bridge seed requires explicit payout outputs');
        }

        let allocatedSats = 0;
        const copiedOutputs = payoutOutputs.map((output) => {
            if (typeof output.address !== 'string' || output.address.trim().length === 0
                || !Number.isSafeInteger(output.amountSats)
                || output.amountSats < 0) {
                throw new Error('PPLNS bridge seed payout outputs require address and amountSats');
            }
            allocatedSats += output.amountSats;
            return { address: output.address, amountSats: output.amountSats };
        });
        if (allocatedSats !== subsidySats) {
            throw new Error('PPLNS bridge seed payout outputs must allocate the entire subsidy');
        }
        return copiedOutputs;
    }

    private validateSubsidyAgainstAuthoritativeTemplate(
        authoritativeTemplate: IBlockTemplate,
    ): number {
        const subsidySats = calculateBlockSubsidySats(
            authoritativeTemplate.height,
            this.getNetworkName(),
            this.getOptionalPositiveIntegerEnv('SUBSIDY_HALVING_INTERVAL'),
        );
        if (this.subsidyValidatedTemplates.has(authoritativeTemplate)) {
            return subsidySats;
        }
        const totalFees = authoritativeTemplate.transactions.reduce((sum, transaction) => {
            if (!Number.isSafeInteger(transaction.fee) || transaction.fee < 0) {
                throw new Error('GBT transaction fee is missing or invalid');
            }
            const next = sum + transaction.fee;
            if (!Number.isSafeInteger(next)) {
                throw new Error('GBT transaction fee total exceeds safe integer range');
            }
            return next;
        }, 0);
        if (subsidySats + totalFees !== authoritativeTemplate.coinbasevalue) {
            throw new Error(
                `GBT coinbase value ${authoritativeTemplate.coinbasevalue} does not equal subsidy ${subsidySats} plus fees ${totalFees}`,
            );
        }
        this.subsidyValidatedTemplates.add(authoritativeTemplate);
        return subsidySats;
    }

    private async handleSv1BridgeUpdate(update: Sv1BridgeUpdate): Promise<void> {
        if (this.processedTemplateEvents.has(update.eventId)) {
            return;
        }
        this.rememberProcessedTemplateEvent(update.eventId);
        const template = {
            ...update.template,
            notificationPublishedAtMs: update.publishedAtMs,
            notificationWorkerReceivedAtMs: update.workerReceivedAtMs,
            notificationWorkerHandledAtMs: Date.now(),
        };
        const payoutMode = template.payoutMode === 'pplns' ? 'pplns' : 'solo';
        if (this.miningInfo?.blocks != null
            && template.height < this.miningInfo.blocks + 1) {
            console.warn(
                `Ignoring stale SV1 bridge ${template.height}:${template.previousblockhash}; current tip is ${this.miningInfo.blocks}`,
            );
            return;
        }
        if (this.isBridgeSupersededByCanonical(template, payoutMode)) {
            console.warn(
                `Ignoring SV1 bridge ${template.height}:${template.previousblockhash}; canonical ${payoutMode} work is already active`,
            );
            return;
        }
        const existing = this.latestBridgeTemplates.get(payoutMode);
        if (existing != null
            && (template.height < existing.height
                || (template.height === existing.height
                    && (template.notificationPublishedAtMs ?? 0)
                        < (existing.notificationPublishedAtMs ?? 0)))) {
            return;
        }
        this.latestBridgeTemplates.set(payoutMode, template);
        this._newSv1BridgeTemplate$.next(template);
    }

    private handleSv1PrestageActivation(activation: Sv1PrestageActivation): void {
        if (this.processedTemplateEvents.has(activation.eventId)) {
            return;
        }
        this.rememberProcessedTemplateEvent(activation.eventId);
        if (this.miningInfo?.blocks != null
            && activation.height < this.miningInfo.blocks + 1) {
            return;
        }
        if (this.isActivationSupersededByCanonical(activation)) {
            return;
        }
        this._newSv1PrestageActivation$.next({
            ...activation,
            workerReceivedAtMs: activation.workerReceivedAtMs ?? Date.now(),
        });
    }

    private isActivationSupersededByCanonical(
        activation: Sv1PrestageActivation,
    ): boolean {
        const canonicalStates = [
            this.canonicalEmissionStates.get(activation.payoutMode),
            this.canonicalEmissionStates.get('all'),
        ].filter((state): state is CanonicalEmissionState => state != null);
        return canonicalStates.some(canonical => {
            if (canonical.height > activation.height) {
                return true;
            }
            if (canonical.height < activation.height) {
                return false;
            }
            if (canonical.previousBlockHash === activation.previousBlockHash) {
                return true;
            }
            return canonical.publishedAtMs == null
                || canonical.publishedAtMs >= activation.publishedAtMs;
        });
    }

    private handleSv1PrestageUpdate(update: Sv1PrestageUpdate): void {
        if (this.processedTemplateEvents.has(update.eventId)) {
            return;
        }
        this.rememberProcessedTemplateEvent(update.eventId);
        const template = {
            ...update.template,
            notificationPreparedAtMs: update.preparedAtMs,
        };
        if (template.previousblockhash !== '0'.repeat(64)
            || template.jobType !== 'empty'
            || template.transactions.length !== 0
            || (this.miningInfo?.blocks != null
                && template.height <= this.miningInfo.blocks + 1)) {
            return;
        }
        this._newSv1PrestageTemplate$.next(template);
    }

    private isBridgeSupersededByCanonical(
        bridge: IBlockTemplate,
        payoutMode: 'solo' | 'pplns',
    ): boolean {
        const bridgePublishedAtMs = bridge.notificationPublishedAtMs;
        const canonicalStates = [
            this.canonicalEmissionStates.get(payoutMode),
            this.canonicalEmissionStates.get('all'),
        ].filter((state): state is CanonicalEmissionState => state != null);

        return canonicalStates.some(canonical => {
            if (canonical.height > bridge.height) {
                return true;
            }
            if (canonical.height < bridge.height) {
                return false;
            }
            if (canonical.previousBlockHash === bridge.previousblockhash) {
                // Once the full job for this tip is active, replaying an empty
                // bridge only discards fees and forces an unnecessary switch.
                return true;
            }
            // A conflicting same-height bridge is a possible reorg only when it
            // is provably newer. Timestamp-less legacy canonical work remains
            // authoritative rather than guessing and switching to an orphan.
            return canonical.publishedAtMs == null
                || bridgePublishedAtMs == null
                || canonical.publishedAtMs >= bridgePublishedAtMs;
        });
    }

    private emitCanonicalTemplate(template: IBlockTemplate): void {
        const payoutMode = template.payoutMode === 'pplns'
            ? 'pplns'
            : template.payoutMode === 'solo'
                ? 'solo'
                : 'all';
        const signature = this.getCanonicalEmissionSignature(template);
        const prior = this.canonicalEmissionStates.get(payoutMode);
        if (prior?.signature === signature) {
            return;
        }
        const applicablePriorModes: Array<'solo' | 'pplns' | 'all'> = payoutMode === 'all'
            ? ['all', 'solo', 'pplns']
            : [payoutMode, 'all'];
        for (const priorMode of applicablePriorModes) {
            const applicablePrior = this.canonicalEmissionStates.get(priorMode);
            if (applicablePrior == null) {
                continue;
            }
            const hasNewerPublicationTime = applicablePrior.publishedAtMs != null
                && template.notificationPublishedAtMs != null
                && template.notificationPublishedAtMs >= applicablePrior.publishedAtMs;
            if (template.height < applicablePrior.height && !hasNewerPublicationTime) {
                console.warn(
                    `Ignoring out-of-order canonical template ${template.height}:${template.previousblockhash}`,
                );
                return;
            }
            if (template.height === applicablePrior.height
                && template.previousblockhash !== applicablePrior.previousBlockHash
                && applicablePrior.publishedAtMs != null
                && template.notificationPublishedAtMs != null
                && template.notificationPublishedAtMs < applicablePrior.publishedAtMs) {
                console.warn(
                    `Ignoring older same-height canonical template ${template.height}:${template.previousblockhash}`,
                );
                return;
            }
        }
        this.canonicalEmissionStates.set(payoutMode, {
            height: template.height,
            previousBlockHash: template.previousblockhash,
            publishedAtMs: template.notificationPublishedAtMs,
            signature,
        });
        const bridgeMode = payoutMode === 'all' ? null : payoutMode;
        const bridge = bridgeMode == null ? null : this.latestBridgeTemplates.get(bridgeMode);
        if (bridge != null
            && template.height >= bridge.height
            && (template.height > bridge.height
                || template.previousblockhash !== bridge.previousblockhash)) {
            this.latestBridgeTemplates.delete(bridgeMode);
        }
        this._newBlockTemplate$.next(template);
    }

    private getCanonicalEmissionSignature(template: IBlockTemplate): string {
        return [
            template.notificationEventId ?? '',
            template.height,
            template.previousblockhash,
            template.payoutMode ?? 'all',
            template.jobType ?? 'full',
            template.payoutSnapshotId ?? '',
            template.longpollid ?? '',
            template.curtime,
            template.coinbasevalue,
            template.transactions.length,
            template.transactions.at(-1)?.txid ?? '',
        ].join(':');
    }

    private rememberProcessedTemplateEvent(eventId: string): void {
        this.processedTemplateEvents.add(eventId);
        if (this.processedTemplateEvents.size > 1024) {
            const oldest = this.processedTemplateEvents.values().next().value;
            if (oldest != null) {
                this.processedTemplateEvents.delete(oldest);
            }
        }
    }

    private queueTemplatePersistence(
        tipHeight: number,
        templates: IBlockTemplate[],
        trace: BlockNotificationTrace,
    ): void {
        this.pendingTemplatePersistence = { tipHeight, templates, trace };
        if (this.persistenceDrainPromise != null) {
            return;
        }
        this.persistenceDrainPromise = this.drainTemplatePersistence()
            .catch(error => console.error('Error saving block template envelope', error))
            .finally(() => {
                this.persistenceDrainPromise = null;
                if (this.pendingTemplatePersistence != null) {
                    this.queueTemplatePersistence(
                        this.pendingTemplatePersistence.tipHeight,
                        this.pendingTemplatePersistence.templates,
                        this.pendingTemplatePersistence.trace,
                    );
                }
            });
    }

    private async drainTemplatePersistence(): Promise<void> {
        while (this.pendingTemplatePersistence != null) {
            const pending = this.pendingTemplatePersistence;
            this.pendingTemplatePersistence = null;
            await this.persistBlockTemplates(
                pending.tipHeight,
                pending.templates,
                pending.trace,
            );
        }
    }

    private async persistBlockTemplates(
        tipHeight: number,
        templates: IBlockTemplate[],
        trace: BlockNotificationTrace,
    ): Promise<void> {
        const envelope: StoredBlockTemplateEnvelope = { schemaVersion: 1, templates };
        await this.persistBlockTemplate(tipHeight, JSON.stringify(envelope), trace);
    }

    private async persistBlockTemplate(
        tipHeight: number,
        serializedBlockTemplate: string,
        trace: BlockNotificationTrace,
    ): Promise<void> {
        try {
            console.log(`Saving block ${tipHeight}`);
            await this.rpcBlockService.saveBlock(tipHeight, serializedBlockTemplate);
            this.markTrace(trace, 'postgres_template_saved');
            console.log('block saved');
        } catch (e) {
            console.error('Error saving block', e);
        }
    }

    private parseStoredBlockTemplates(data: string): IBlockTemplate[] {
        const parsed = JSON.parse(data) as IBlockTemplate | StoredBlockTemplateEnvelope;
        if ((parsed as StoredBlockTemplateEnvelope)?.schemaVersion === 1
            && Array.isArray((parsed as StoredBlockTemplateEnvelope).templates)) {
            return (parsed as StoredBlockTemplateEnvelope).templates;
        }
        return [parsed as IBlockTemplate];
    }

    public async getMiningInfo(): Promise<IMiningInfo> {
        try {
            return await this.callRpc<IMiningInfo>('getmininginfo');
        } catch (e) {
            console.error('Error getmininginfo', e.message);
            return null;
        }

    }

    public async SUBMIT_BLOCK(hexdata: string): Promise<string> {
        let response: string = 'unknown';
        try {
            const submissionResult = await this.callRpc<string | null>('submitblock', [hexdata]);
            if (submissionResult != null) {
                response = submissionResult;
            } else {
                try {
                    const blockHash = this.deriveSubmittedBlockHash(hexdata);
                    const blockHeader = await this.callRpc<{ confirmations?: number }>(
                        'getblockheader',
                        [blockHash, true],
                    );
                    const confirmations = blockHeader?.confirmations;
                    response = typeof confirmations === 'number'
                        && Number.isFinite(confirmations)
                        && confirmations > 0
                        ? 'SUCCESS!'
                        : `ACCEPTED_BLOCK_NOT_ACTIVE_CHAIN: confirmations=${String(confirmations)}`;
                } catch (verificationError) {
                    const message = verificationError instanceof Error
                        ? verificationError.message
                        : String(verificationError);
                    response = `ACTIVE_CHAIN_VERIFICATION_FAILED: ${message}`;
                }
            }
            console.log(`BLOCK SUBMISSION RESPONSE: ${response}`);
            console.log(hexdata);
            console.log(JSON.stringify(response));
        } catch (e) {
            response = e instanceof Error ? e.message : String(e);
            console.log(`BLOCK SUBMISSION RESPONSE ERROR: ${response}`);
        }
        return response;

    }

    private deriveSubmittedBlockHash(hexdata: string): string {
        const normalizedHex = hexdata.trim();
        const headerHex = normalizedHex.slice(0, 160);
        if (headerHex.length !== 160 || !/^[0-9a-f]+$/i.test(headerHex)) {
            throw new Error('submitted block does not contain a valid 80-byte header');
        }
        const header = Buffer.from(headerHex, 'hex');
        const firstHash = crypto.createHash('sha256').update(header).digest();
        return crypto.createHash('sha256').update(firstHash).digest().reverse().toString('hex');
    }

    /** BIP23 proposal validation without submitting or requiring proof of work. */
    public async TEST_BLOCK_PROPOSAL(hexdata: string): Promise<string | null> {
        return this.callRpc<string | null>('getblocktemplate', [{
            mode: 'proposal',
            data: hexdata,
            rules: ['segwit'],
        }]);
    }

    public async TEST_MEMPOOL_ACCEPT(rawTransactions: Buffer[]): Promise<Array<{
        txid?: string;
        wtxid?: string;
        allowed: boolean;
        rejectReason?: string;
        rejectDetails?: string;
    }>> {
        return this.callRpc('testmempoolaccept', [
            rawTransactions.map(tx => tx.toString('hex')),
        ]);
    }

    private async callRpc<T>(
        method: string,
        params: unknown[] = [],
        timeoutMs?: number,
    ): Promise<T> {
        return this.callRpcWithClient(this.client, method, params, timeoutMs);
    }

    private async callRpcWithClient<T>(
        client: AxiosInstance,
        method: string,
        params: unknown[] = [],
        timeoutMs?: number,
    ): Promise<T> {
        const response = await client.post('', {
            jsonrpc: '1.0',
            id: ++this.rpcRequestId,
            method,
            params
        }, timeoutMs == null ? undefined : { timeout: timeoutMs });

        if (response.data.error != null) {
            throw response.data.error;
        }

        return response.data.result;
    }

    private calculateNetworkDifficulty(nBits: number) {
        const mantissa: number = nBits & 0x007fffff;
        const exponent: number = (nBits >> 24) & 0xff;
        const target: number = mantissa * Math.pow(256, (exponent - 3));
        const maxTarget = Math.pow(2, 208) * 65535;
        return maxTarget / target;
    }

    private configureAuxiliaryTemplateSources(options: {
        user: string;
        pass: string;
        port: number;
        timeout: number;
    }): void {
        const configured = this.configService.get<string>('BITCOIN_RPC_AUX_URLS')
            ?? process.env.BITCOIN_RPC_AUX_URLS
            ?? '';
        const urls = [...new Set(configured
            .split(',')
            .map(value => value.trim())
            .filter(Boolean))];
        urls.forEach((url, index) => {
            this.auxiliaryTemplateSources.push({
                name: `aux-${index + 1}`,
                client: axios.create({
                    baseURL: this.buildRpcUrl(url, options.port),
                    timeout: options.timeout,
                    auth: {
                        username: options.user,
                        password: options.pass,
                    },
                }),
                latestLongpollId: null,
                longpollLoopStarted: false,
            });
        });
    }

    private async isAuxiliaryTemplateAuthorizedByPrimary(
        template: IBlockTemplate,
        source: TemplateRpcSource,
    ): Promise<boolean> {
        try {
            const primaryBestBlockHash = await this.callRpc<string>('getbestblockhash');
            if (primaryBestBlockHash === template.previousblockhash) {
                return true;
            }
            console.warn(JSON.stringify({
                event: 'aux_template_rejected',
                templateSource: source.name,
                templateHeight: template.height,
                previousBlockHash: template.previousblockhash,
                primaryBestBlockHash,
                reason: 'primary-tip-mismatch',
            }));
            return false;
        } catch (error) {
            console.warn(JSON.stringify({
                event: 'aux_template_rejected',
                templateSource: source.name,
                templateHeight: template.height,
                previousBlockHash: template.previousblockhash,
                reason: 'primary-verification-failed',
                error: error.message ?? String(error),
            }));
            return false;
        }
    }

    private buildRpcUrl(url: string, port: number): string {
        const normalizedUrl = /^https?:\/\//i.test(url) ? url : `http://${url}`;
        const rpcUrl = new URL(normalizedUrl);
        if (Number.isFinite(port) && port > 0) {
            rpcUrl.port = port.toString();
        }
        return rpcUrl.toString();
    }

    private startTrace(
        reason: TemplateRefreshReason,
        sourceNotificationReceivedAtMs?: number,
        templateSource = 'primary',
    ): BlockNotificationTrace {
        return {
            eventId: `${reason}:${Date.now()}:${this.rpcRequestId + 1}`,
            reason,
            startedWallMs: Date.now(),
            startedMonotonic: process.hrtime.bigint(),
            sourceNotificationReceivedAtMs,
            templateSource,
            stages: { start: 0 },
        };
    }

    private markTrace(trace: BlockNotificationTrace, stage: string): void {
        trace.stages[stage] = Number(process.hrtime.bigint() - trace.startedMonotonic) / 1e6;
    }

    private logSourceNotification(trace: BlockNotificationTrace, blockTemplate: IBlockTemplate): void {
        if (trace.sourceNotificationReceivedAtMs == null
            || (trace.reason !== 'new_block' && trace.reason !== 'longpoll')) {
            return;
        }

        console.log(JSON.stringify({
            event: 'block_source_notification',
            eventId: trace.eventId,
            source: trace.reason === 'new_block' ? 'zmq' : 'longpoll',
            templateSource: trace.templateSource,
            receivedAt: new Date(trace.sourceNotificationReceivedAtMs).toISOString(),
            receivedAtMs: trace.sourceNotificationReceivedAtMs,
            tipHeight: blockTemplate.height - 1,
            templateHeight: blockTemplate.height,
            previousBlockHash: blockTemplate.previousblockhash,
            sourceToTemplateReadyMs: trace.stages.template_ready,
            stagesMs: trace.stages,
        }));
    }

    private logTrace(trace: BlockNotificationTrace, blockTemplate: IBlockTemplate): void {
        if (!this.shouldLogBlockNotificationTrace(trace)) {
            return;
        }

        console.log(JSON.stringify({
            event: 'block_notification_trace',
            eventId: trace.eventId,
            reason: trace.reason,
            templateSource: trace.templateSource,
            tipHeight: blockTemplate.height - 1,
            templateHeight: blockTemplate.height,
            previousBlockHash: blockTemplate.previousblockhash,
            payoutMode: blockTemplate.payoutMode ?? 'all',
            jobType: blockTemplate.jobType ?? 'full',
            startedAt: new Date(trace.startedWallMs).toISOString(),
            sourceNotificationReceivedAt: trace.sourceNotificationReceivedAtMs == null
                ? undefined
                : new Date(trace.sourceNotificationReceivedAtMs).toISOString(),
            sourceNotificationReceivedAtMs: trace.sourceNotificationReceivedAtMs,
            stagesMs: trace.stages,
        }));
    }

    private shouldLogBlockNotificationTrace(trace: BlockNotificationTrace): boolean {
        if (trace.reason === 'new_block') {
            return true;
        }
        return process.env.BLOCK_NOTIFICATION_TRACE_LOG_ENABLED?.toLowerCase() === 'true';
    }

    private hasConfiguredPplnsListeners(): boolean {
        return PPLNS_LISTENER_CONFIG_KEYS.some(key => {
            const configured = this.configService.get<string>(key) ?? process.env[key];
            if (configured == null) {
                return false;
            }
            return String(configured)
                .split(',')
                .some(value => value.trim().length > 0);
        });
    }

    private getPositiveIntegerEnv(key: string, fallback: number): number {
        const configured = Number(this.configService.get<string>(key) ?? process.env[key]);
        return Number.isInteger(configured) && configured > 0 ? configured : fallback;
    }

    private getOptionalPositiveIntegerEnv(key: string): number | undefined {
        const configured = Number(this.configService.get<string>(key) ?? process.env[key]);
        return Number.isInteger(configured) && configured > 0 ? configured : undefined;
    }

    private isSv1SubsidyBridgeEnabled(): boolean {
        const configured = this.configService.get<string>('SV1_SUBSIDY_BRIDGE_ENABLED')
            ?? process.env.SV1_SUBSIDY_BRIDGE_ENABLED;
        return configured?.toLowerCase() !== 'false';
    }

    private isSv1CompactActivationEnabled(): boolean {
        const configured = this.configService.get<string>('SV1_COMPACT_PRESTAGE_ACTIVATION_ENABLED')
            ?? process.env.SV1_COMPACT_PRESTAGE_ACTIVATION_ENABLED;
        return configured?.toLowerCase() !== 'false';
    }

    private isSv1CompatibilityBridgeEnabled(): boolean {
        const configured = this.configService.get<string>('SV1_COMPACT_ACTIVATION_COMPATIBILITY_BRIDGE')
            ?? process.env.SV1_COMPACT_ACTIVATION_COMPATIBILITY_BRIDGE;
        return configured?.toLowerCase() === 'true';
    }

    private getSv1SubsidyBridgePayoutModes(): ReadonlySet<'solo' | 'pplns'> {
        const configured = this.configService.get<string>('SV1_SUBSIDY_BRIDGE_PAYOUT_MODES')
            ?? process.env.SV1_SUBSIDY_BRIDGE_PAYOUT_MODES
            ?? 'solo';
        const modes = new Set<'solo' | 'pplns'>();
        for (const token of configured.split(',')) {
            const mode = token.trim().toLowerCase();
            if (mode === 'solo' || mode === 'pplns') {
                modes.add(mode);
            }
        }
        if (modes.size === 0) {
            modes.add('solo');
        }
        return modes;
    }

    private getNetworkName(): BitcoinNetworkName {
        const network = this.configService.get<string>('NETWORK') ?? process.env.NETWORK;
        if (network === 'mainnet' || network === 'testnet' || network === 'regtest') {
            return network;
        }
        throw new Error(`Invalid NETWORK configuration: ${network ?? 'unset'}`);
    }

    private validateConfiguredNetworkAgainstCore(
        coreChain: IMiningInfo['chain'],
    ): void {
        const configuredNetwork = this.getNetworkName();
        const expectedChain: IMiningInfo['chain'] = configuredNetwork === 'mainnet'
            ? 'main'
            : configuredNetwork === 'testnet'
                ? 'test'
                : 'regtest';
        if (coreChain !== expectedChain) {
            throw new Error(
                `NETWORK=${configuredNetwork} does not match Bitcoin Core chain=${coreChain ?? 'unset'}`,
            );
        }
    }
}
