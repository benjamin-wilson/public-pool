import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'net';
import { monitorEventLoopDelay } from 'perf_hooks';
import { Subscription } from 'rxjs';

import { StratumV1Client } from '../models/StratumV1Client';
import { StratumV2Client } from '../models/StratumV2Client';
import { UserAgentReportService } from '../ORM/_views/user-agent-report/user-agent-report.service';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientService } from '../ORM/client/client.service';
import { PayoutSnapshotService } from '../ORM/payout-snapshot/payout-snapshot.service';
import { ShareAccountingService } from '../ORM/share-accounting/share-accounting.service';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { NotificationService } from './notification.service';
import { RedisMessagingService } from './redis-messaging.service';
import { StratumV1JobsService } from './stratum-v1-jobs.service';
import { StratumV2Service } from './stratum-v2.service';
import { parsePayoutModePorts, PayoutMode } from '../types/payout-mode';

import { readFileSync } from 'fs';
import { TlsOptions, TLSSocket, createServer } from 'tls';
import * as path from 'path';

interface StratumListenerState {
    port: number;
    secure: boolean;
    payoutMode: PayoutMode;
    server: Server | null;
    paused: boolean;
}

const DEFAULT_BACKPRESSURE_CHECK_INTERVAL_MS = 5000;
const DEFAULT_BACKPRESSURE_EVENT_LOOP_P95_MS = 2000;
const DEFAULT_BACKPRESSURE_EVENT_LOOP_RESUME_P95_MS = 250;
const DEFAULT_BACKPRESSURE_RSS_MB = 2500;
const DEFAULT_BACKPRESSURE_RESUME_RSS_MB = 2000;
const DEFAULT_BACKPRESSURE_HEALTHY_CHECKS = 3;
const DEFAULT_MAX_CONNECTIONS_PER_LISTENER = 10000;
const DEFAULT_TLS_HANDSHAKE_TIMEOUT_MS = 10000;
const DEFAULT_SOCKET_TIMEOUT_MS = 1000 * 60 * 60;
const DEFAULT_TCP_KEEPALIVE_INITIAL_DELAY_MS = 1000 * 60;
const DEFAULT_PRESTAGE_BATCH_SIZE = 500;
const DEFAULT_FANOUT_TARGET_CLIENTS_PER_WORKER = 10000;



@Injectable()
export class StratumV1Service implements OnModuleInit, OnModuleDestroy {

    private socketTimeout = 0;
    private emptySocket = 0;
    private normalClosure = 0;
    private errorClosure = 0;
    private readonly listeners: StratumListenerState[] = [];
    private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
    private backpressureMonitor: NodeJS.Timeout | null = null;
    private healthyBackpressureChecks = 0;
    private readonly clients = new Set<StratumV1Client>();
    private jobBroadcastSubscription: Subscription | null = null;
    private jobPrestageSubscription: Subscription | null = null;
    private readonly pendingPrestageJobs = new Map<PayoutMode, import('./stratum-v1-jobs.service').IJobTemplate>();
    private prestageDrainRunning = false;
    private prestageGeneration = 0;

    constructor(
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly clientService: ClientService,
        private readonly notificationService: NotificationService,
        private readonly blocksService: BlocksService,
        private readonly configService: ConfigService,
        private readonly stratumV1JobsService: StratumV1JobsService,
        private readonly addressSettingsService: AddressSettingsService,
        private readonly stratumV2Service: StratumV2Service,
        private readonly userAgentReportService: UserAgentReportService,
        private readonly shareAccountingService?: ShareAccountingService,
        private readonly redisMessagingService?: RedisMessagingService,
        private readonly payoutSnapshotService?: PayoutSnapshotService
    ) {

    }

    async onModuleInit(): Promise<void> {

        if (process.env.API_ONLY == 'true') {
            console.log('API-only process skipping Stratum socket listeners');
            return;
        }

        if (process.env.MASTER == 'true') {
            await this.clientService.deleteAll();
            await this.userAgentReportService.refreshReport();
            console.log('Master process skipping Stratum socket listeners');
            return;
        }

        this.jobBroadcastSubscription = (
            this.stratumV1JobsService.sv1MiningJob$
            ?? this.stratumV1JobsService.newMiningJob$
        ).subscribe({
            next: jobTemplate => this.broadcastMiningJob(jobTemplate),
            error: error => console.error(`SV1 job broadcast subscription failed: ${error.message}`),
        });
        this.jobPrestageSubscription = this.stratumV1JobsService.sv1PrestageJob$?.subscribe({
            next: jobTemplate => this.queuePrestageMiningJob(jobTemplate),
            error: error => console.error(`SV1 job prestage subscription failed: ${error.message}`),
        }) ?? null;

        // wait for all the other processes to init for an even connection distribution 
        setTimeout(() => {
            parsePayoutModePorts(
                process.env.STRATUM_PORTS,
                process.env.PPLNS_STRATUM_PORTS,
            ).forEach(({ port, payoutMode }) => {
                this.startSocketServer(port, payoutMode);
            });
            if (process.env.STRATUM_SECURE?.toLowerCase() === 'true') {
                parsePayoutModePorts(
                    process.env.SECURE_STRATUM_PORTS,
                    process.env.PPLNS_SECURE_STRATUM_PORTS,
                ).forEach(({ port, payoutMode }) => {
                    this.startSecureSocketServer(port, payoutMode);
                });
            }
        }, (10000));

        setInterval(() => {
            console.log(`Socket stats: ${this.emptySocket} empty, ${this.socketTimeout} timeouts, ${this.normalClosure} normal closure, ${this.errorClosure} error closure`);
            this.emptySocket = 0;
            this.socketTimeout = 0;
            this.normalClosure = 0;
            this.errorClosure = 0;
        }, 1000 * 60);

        this.startBackpressureMonitor();

    }

    public onModuleDestroy(): void {
        this.jobBroadcastSubscription?.unsubscribe();
        this.jobBroadcastSubscription = null;
        this.jobPrestageSubscription?.unsubscribe();
        this.jobPrestageSubscription = null;
        this.prestageGeneration++;
        this.pendingPrestageJobs.clear();
        if (this.backpressureMonitor != null) {
            clearInterval(this.backpressureMonitor);
            this.backpressureMonitor = null;
        }
    }

    private startSocketServer(port: number, payoutMode: PayoutMode) {
        const listener: StratumListenerState = {
            port,
            secure: false,
            payoutMode,
            server: null,
            paused: false
        };
        this.listeners.push(listener);
        this.listen(listener);
    }

    private createSocketServer(payoutMode: PayoutMode): Server {
        const server = new Server(async (socket: Socket) => {
            socket.setTimeout(this.getSocketTimeoutMs());
            socket.setKeepAlive(true, this.getTcpKeepAliveInitialDelayMs());
            socket.setNoDelay(true);

            let client: StratumV1Client | StratumV2Client = null;
            let protocol: 'v1' | 'v2' | null = null;
            let cleanedUp = false;

            // Unified cleanup function
            const cleanup = async (reason: string) => {
                if (cleanedUp) {
                    return;
                }
                cleanedUp = true;

                const currentClient = client;
                client = null;

                try {
                    if (currentClient != null) {
                        const initializedClient = protocol === 'v2'
                            || (currentClient as StratumV1Client).extraNonceAndSessionId != null;
                        await currentClient.destroy();
                        if (protocol === 'v1') {
                            this.clients.delete(currentClient as StratumV1Client);
                        }
                        if (initializedClient) {
                            if (reason == 'Error') {
                                this.errorClosure++;
                            } else {
                                this.normalClosure++;
                            }
                        }
                    }
                } finally {
                    socket.removeAllListeners('close');
                    socket.removeAllListeners('timeout');
                    socket.removeAllListeners('error');
                    socket.removeAllListeners('data');
                    if (!socket.destroyed) {
                        socket.end();
                        socket.destroy();
                    }
                }
            };

            // Handle client disconnection
            socket.on('close', async (hadError: boolean) => {
                await cleanup(hadError ? "Error" : "Normal Closure");
            });

            // Handle socket timeouts
            socket.on('timeout', async () => {
                if (socket.bytesRead == 0 || socket.bytesWritten == 0) {
                    this.emptySocket++;
                } else {
                    this.socketTimeout++;
                }
                await cleanup("Timeout");
            });

            // Handle errors properly
            socket.on('error', async (error: Error) => {
                await cleanup("Error");
            });

            socket.once('data', async (firstChunk: Buffer) => {
                try {
                    protocol = this.detectProtocol(firstChunk);
                    if (protocol === 'v1') {
                        client = this.createV1Client(socket, 'sv1', payoutMode);
                        socket.emit('data', firstChunk);
                        return;
                    }

                    if (protocol === 'v2') {
                        await this.stratumV2Service.ensureInitialized();
                        client = this.stratumV2Service.createClient(socket, firstChunk, payoutMode);
                        return;
                    }

                    if (!socket.destroyed) {
                        socket.end();
                        socket.destroy();
                    }
                } catch (error) {
                    console.error(`Protocol detection failed: ${error.message}`);
                    await cleanup('Error');
                }
            });

        });

        // Ensure server itself handles errors
        server.on('error', (err) => {
            console.error(`Server error: ${err.message}`);
        });
        this.configureConnectionLimit(server);

        return server;
    }

    private createV1Client(socket: Socket, accountingProtocol: 'sv1' | 'sv1_tls', payoutMode: PayoutMode): StratumV1Client {
        const client = new StratumV1Client(
            socket,
            this.stratumV1JobsService,
            this.bitcoinRpcService,
            this.clientService,
            this.notificationService,
            this.blocksService,
            this.configService,
            this.addressSettingsService,
            this.shareAccountingService,
            this.redisMessagingService,
            this.payoutSnapshotService,
            accountingProtocol,
            payoutMode,
        );
        this.clients.add(client);
        return client;
    }

    private startSecureSocketServer(port: number, payoutMode: PayoutMode) {
        const listener: StratumListenerState = {
            port,
            secure: true,
            payoutMode,
            server: null,
            paused: false
        };
        this.listeners.push(listener);
        this.listen(listener);
    }

    private createSecureSocketServer(payoutMode: PayoutMode): Server {

        const currentDirectory = process.cwd();
        const keyPath = path.join(currentDirectory, 'secrets', 'key.pem');
        const certPath = path.join(currentDirectory, 'secrets', 'cert.pem');

        const tlsOptions: TlsOptions = {
            key: readFileSync(keyPath),
            cert: readFileSync(certPath),
            handshakeTimeout: this.getTlsHandshakeTimeoutMs()
        };

        const server = createServer(tlsOptions, async (socket: TLSSocket) => {
            socket.setTimeout(this.getSocketTimeoutMs());
            socket.setKeepAlive(true, this.getTcpKeepAliveInitialDelayMs());
            socket.setNoDelay(true);

            const client = this.createV1Client(socket, 'sv1_tls', payoutMode);
            let cleanedUp = false;

            const cleanup = async (reason: string) => {
                if (cleanedUp) {
                    return;
                }
                cleanedUp = true;

                try {
                    const initializedClient = client.extraNonceAndSessionId != null;
                    await client.destroy();
                    this.clients.delete(client);
                    if (initializedClient) {
                        if (reason === 'Error') {
                            this.errorClosure++;
                        } else {
                            this.normalClosure++;
                        }
                    }
                } finally {
                    socket.removeAllListeners('close');
                    socket.removeAllListeners('timeout');
                    socket.removeAllListeners('error');
                    socket.removeAllListeners('data');
                    if (!socket.destroyed) {
                        socket.end();
                        socket.destroy();
                    }
                }
            };

            socket.on('close', async (hadError: boolean) => {
                await cleanup(hadError ? 'Error' : 'Normal Closure');
            });

            socket.on('timeout', async () => {
                if (socket.bytesRead === 0 || socket.bytesWritten === 0) {
                    this.emptySocket++;
                } else {
                    this.socketTimeout++;
                }
                await cleanup('Timeout');
            });

            socket.on('error', async (error: Error) => {
                await cleanup('Error');
            });

            // your protocol handling stays the same
        });

        server.on('error', (err) => {
            console.error(`Server error: ${err.message}`);
        });
        this.configureConnectionLimit(server);

        return server;

    }

    private listen(listener: StratumListenerState) {
        if (listener.server != null) {
            return;
        }

        const server = listener.secure ? this.createSecureSocketServer(listener.payoutMode) : this.createSocketServer(listener.payoutMode);
        listener.server = server;
        listener.paused = false;

        server.listen(listener.port, () => {
            console.log(`${listener.secure ? 'Stratum TLS' : 'Stratum'} ${listener.payoutMode} server is listening on port ${listener.port}`);
        });
    }

    private startBackpressureMonitor() {
        if (this.isBackpressureDisabled() || this.backpressureMonitor != null) {
            return;
        }

        this.eventLoopDelay.enable();
        this.backpressureMonitor = setInterval(() => {
            this.checkBackpressure();
        }, this.getBackpressureCheckIntervalMs());
    }

    private checkBackpressure() {
        const eventLoopP95Ms = this.getEventLoopP95Ms();
        const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const overloaded = eventLoopP95Ms >= this.getBackpressureEventLoopP95Ms()
            || rssMb >= this.getBackpressureRssMb();
        const paused = this.listeners.some(listener => listener.paused);

        if (overloaded) {
            this.healthyBackpressureChecks = 0;
            if (!paused) {
                this.pauseAccepting(eventLoopP95Ms, rssMb);
            }
            this.eventLoopDelay.reset();
            return;
        }

        if (!paused) {
            this.eventLoopDelay.reset();
            return;
        }

        const healthy = eventLoopP95Ms <= this.getBackpressureResumeEventLoopP95Ms()
            && rssMb <= this.getBackpressureResumeRssMb();
        if (!healthy) {
            this.healthyBackpressureChecks = 0;
            this.eventLoopDelay.reset();
            return;
        }

        this.healthyBackpressureChecks++;
        if (this.healthyBackpressureChecks >= this.getBackpressureHealthyChecks()) {
            this.resumeAccepting(eventLoopP95Ms, rssMb);
            this.healthyBackpressureChecks = 0;
        }

        this.eventLoopDelay.reset();
    }

    private pauseAccepting(eventLoopP95Ms: number, rssMb: number) {
        console.warn(`Pausing Stratum accepts: eventLoopP95Ms=${eventLoopP95Ms}, rssMb=${rssMb}`);
        for (const listener of this.listeners) {
            if (listener.paused || listener.server == null) {
                continue;
            }

            const server = listener.server;
            listener.server = null;
            listener.paused = true;
            server.close((error) => {
                if (error != null) {
                    console.error(`Error while pausing Stratum listener on port ${listener.port}: ${error.message}`);
                }
            });
        }
    }

    private resumeAccepting(eventLoopP95Ms: number, rssMb: number) {
        console.warn(`Resuming Stratum accepts: eventLoopP95Ms=${eventLoopP95Ms}, rssMb=${rssMb}`);
        for (const listener of this.listeners) {
            if (!listener.paused || listener.server != null) {
                continue;
            }

            this.listen(listener);
        }
    }

    private getEventLoopP95Ms() {
        return Math.round(this.eventLoopDelay.percentile(95) / 1e6);
    }

    private broadcastMiningJob(jobTemplate: import('./stratum-v1-jobs.service').IJobTemplate): void {
        const fanoutStartedAtMs = Date.now();
        const startedAt = process.hrtime.bigint();
        const totalClients = this.clients.size;
        const targetClientsPerWorker = this.getPositiveIntegerEnv(
            'STRATUM_FANOUT_TARGET_CLIENTS_PER_WORKER',
            DEFAULT_FANOUT_TARGET_CLIENTS_PER_WORKER,
        );
        const milestoneIndexes = {
            p50: Math.max(1, Math.ceil(totalClients * 0.5)),
            p95: Math.max(1, Math.ceil(totalClients * 0.95)),
            p99: Math.max(1, Math.ceil(totalClients * 0.99)),
        };
        const milestoneMs: { p50?: number; p95?: number; p99?: number } = {};
        let visited = 0;
        let written = 0;
        let skipped = 0;
        let backpressured = 0;
        let closed = 0;
        let errors = 0;
        let preStaged = 0;
        let bytesQueued = 0;
        let maxBufferedBytes = 0;

        const elapsedMs = () => Number(process.hrtime.bigint() - startedAt) / 1e6;
        for (const client of this.clients) {
            visited++;
            try {
                const result = client.broadcastMiningJob(jobTemplate);
                if (result.preStaged) {
                    preStaged++;
                }
                bytesQueued += result.bytes;
                maxBufferedBytes = Math.max(maxBufferedBytes, result.bufferedBytes);
                switch (result.status) {
                    case 'written': written++; break;
                    case 'backpressured': backpressured++; break;
                    case 'closed': closed++; break;
                    case 'error': errors++; break;
                    default: skipped++; break;
                }
            } catch (error) {
                errors++;
                void client.destroy();
            }

            if (milestoneMs.p50 == null && visited >= milestoneIndexes.p50) {
                milestoneMs.p50 = elapsedMs();
            }
            if (milestoneMs.p95 == null && visited >= milestoneIndexes.p95) {
                milestoneMs.p95 = elapsedMs();
            }
            if (milestoneMs.p99 == null && visited >= milestoneIndexes.p99) {
                milestoneMs.p99 = elapsedMs();
            }
        }

        if (!this.shouldLogJobFanout(jobTemplate.blockData.isNewBlock, errors)) {
            return;
        }

        console.log(JSON.stringify({
            event: 'stratum_job_fanout',
            eventId: jobTemplate.blockData.notificationEventId,
            sourceToFanoutStartMs: jobTemplate.blockData.sourceNotificationReceivedAtMs == null
                ? undefined
                : fanoutStartedAtMs - jobTemplate.blockData.sourceNotificationReceivedAtMs,
            masterPrepareMs: jobTemplate.blockData.notificationPreparedAtMs == null
                || jobTemplate.blockData.sourceNotificationReceivedAtMs == null
                ? undefined
                : jobTemplate.blockData.notificationPreparedAtMs
                    - jobTemplate.blockData.sourceNotificationReceivedAtMs,
            masterPublishRequestMs: jobTemplate.blockData.notificationPublishedAtMs == null
                || jobTemplate.blockData.sourceNotificationReceivedAtMs == null
                ? undefined
                : jobTemplate.blockData.notificationPublishedAtMs
                    - jobTemplate.blockData.sourceNotificationReceivedAtMs,
            masterToWorkerReceiveMs: jobTemplate.blockData.notificationPublishedAtMs == null
                || jobTemplate.blockData.notificationWorkerReceivedAtMs == null
                ? undefined
                : jobTemplate.blockData.notificationWorkerReceivedAtMs
                    - jobTemplate.blockData.notificationPublishedAtMs,
            workerReceiveToHandleMs: jobTemplate.blockData.notificationWorkerReceivedAtMs == null
                || jobTemplate.blockData.notificationWorkerHandledAtMs == null
                ? undefined
                : jobTemplate.blockData.notificationWorkerHandledAtMs
                    - jobTemplate.blockData.notificationWorkerReceivedAtMs,
            workerHandleToFanoutStartMs: jobTemplate.blockData.notificationWorkerHandledAtMs == null
                ? undefined
                : fanoutStartedAtMs - jobTemplate.blockData.notificationWorkerHandledAtMs,
            redisToFanoutStartMs: jobTemplate.blockData.notificationPublishedAtMs == null
                ? undefined
                : fanoutStartedAtMs - jobTemplate.blockData.notificationPublishedAtMs,
            templateId: jobTemplate.blockData.id,
            height: jobTemplate.blockData.height,
            jobType: jobTemplate.blockData.jobType,
            isNewBlock: jobTemplate.blockData.isNewBlock,
            cleanJobs: jobTemplate.blockData.clearJobs,
            clients: totalClients,
            targetClientsPerWorker,
            overTargetClients: Math.max(0, totalClients - targetClientsPerWorker),
            written,
            skipped,
            backpressured,
            closed,
            errors,
            preStaged,
            bytesQueued,
            maxBufferedBytes,
            milestoneMs,
            totalMs: elapsedMs(),
        }));
    }

    private queuePrestageMiningJob(
        jobTemplate: import('./stratum-v1-jobs.service').IJobTemplate,
    ): void {
        const payoutMode = jobTemplate.blockData.payoutMode === 'pplns' ? 'pplns' : 'solo';
        this.pendingPrestageJobs.set(payoutMode, jobTemplate);
        if (this.prestageDrainRunning) {
            return;
        }
        this.prestageDrainRunning = true;
        const generation = this.prestageGeneration;
        void this.drainPrestageMiningJobs(generation).finally(() => {
            this.prestageDrainRunning = false;
            if (generation === this.prestageGeneration
                && this.pendingPrestageJobs.size > 0) {
                const latest = this.pendingPrestageJobs.values().next().value;
                if (latest != null) {
                    this.queuePrestageMiningJob(latest);
                }
            }
        });
    }

    private async drainPrestageMiningJobs(generation: number): Promise<void> {
        while (generation === this.prestageGeneration
            && this.pendingPrestageJobs.size > 0) {
            const [payoutMode, jobTemplate] = this.pendingPrestageJobs.entries().next().value as [
                PayoutMode,
                import('./stratum-v1-jobs.service').IJobTemplate,
            ];
            this.pendingPrestageJobs.delete(payoutMode);
            const clients = [...this.clients];
            const batchSize = this.getPositiveIntegerEnv(
                'SV1_PRESTAGE_BATCH_SIZE',
                DEFAULT_PRESTAGE_BATCH_SIZE,
            );
            const startedAt = process.hrtime.bigint();
            let staged = 0;
            let skipped = 0;
            let errors = 0;
            for (let offset = 0; offset < clients.length; offset += batchSize) {
                if (generation !== this.prestageGeneration) {
                    return;
                }
                for (const client of clients.slice(offset, offset + batchSize)) {
                    try {
                        if (client.preStageMiningJob(jobTemplate)) {
                            staged++;
                        } else {
                            skipped++;
                        }
                    } catch {
                        errors++;
                    }
                }
                // Staging is deliberately background work. Yield between bounded
                // batches so share parsing and urgent bridge callbacks stay live.
                if (offset + batchSize < clients.length) {
                    await new Promise<void>(resolve => setImmediate(resolve));
                }
            }
            console.log(JSON.stringify({
                event: 'sv1_job_prestage',
                eventId: jobTemplate.blockData.notificationEventId,
                height: jobTemplate.blockData.height,
                payoutMode,
                clients: clients.length,
                staged,
                skipped,
                errors,
                totalMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
            }));
        }
    }

    private shouldLogJobFanout(isNewBlock: boolean, errors: number): boolean {
        if (errors > 0 || isNewBlock) {
            return true;
        }
        return process.env.STRATUM_FANOUT_LOG_ENABLED?.toLowerCase() === 'true';
    }

    private isBackpressureDisabled() {
        return process.env.STRATUM_BACKPRESSURE_ENABLED?.toLowerCase() === 'false';
    }

    private getBackpressureCheckIntervalMs() {
        return this.getPositiveIntegerEnv('STRATUM_BACKPRESSURE_CHECK_INTERVAL_MS', DEFAULT_BACKPRESSURE_CHECK_INTERVAL_MS);
    }

    private getBackpressureEventLoopP95Ms() {
        return this.getPositiveIntegerEnv('STRATUM_BACKPRESSURE_EVENT_LOOP_P95_MS', DEFAULT_BACKPRESSURE_EVENT_LOOP_P95_MS);
    }

    private getBackpressureResumeEventLoopP95Ms() {
        return this.getPositiveIntegerEnv('STRATUM_BACKPRESSURE_EVENT_LOOP_RESUME_P95_MS', DEFAULT_BACKPRESSURE_EVENT_LOOP_RESUME_P95_MS);
    }

    private getBackpressureRssMb() {
        return this.getPositiveIntegerEnv('STRATUM_BACKPRESSURE_RSS_MB', DEFAULT_BACKPRESSURE_RSS_MB);
    }

    private getBackpressureResumeRssMb() {
        return this.getPositiveIntegerEnv('STRATUM_BACKPRESSURE_RESUME_RSS_MB', DEFAULT_BACKPRESSURE_RESUME_RSS_MB);
    }

    private getBackpressureHealthyChecks() {
        return this.getPositiveIntegerEnv('STRATUM_BACKPRESSURE_HEALTHY_CHECKS', DEFAULT_BACKPRESSURE_HEALTHY_CHECKS);
    }

    private configureConnectionLimit(server: Server) {
        server.maxConnections = this.getMaxConnectionsPerListener();
        (server as Server & { dropMaxConnection: boolean }).dropMaxConnection = true;
    }

    private getMaxConnectionsPerListener() {
        return this.getPositiveIntegerEnv('STRATUM_MAX_CONNECTIONS_PER_LISTENER', DEFAULT_MAX_CONNECTIONS_PER_LISTENER);
    }

    private getTlsHandshakeTimeoutMs() {
        return this.getPositiveIntegerEnv('STRATUM_TLS_HANDSHAKE_TIMEOUT_MS', DEFAULT_TLS_HANDSHAKE_TIMEOUT_MS);
    }

    private getSocketTimeoutMs() {
        return this.getPositiveIntegerEnv('STRATUM_SOCKET_TIMEOUT_MS', DEFAULT_SOCKET_TIMEOUT_MS);
    }

    private getTcpKeepAliveInitialDelayMs() {
        return this.getPositiveIntegerEnv('STRATUM_TCP_KEEPALIVE_INITIAL_DELAY_MS', DEFAULT_TCP_KEEPALIVE_INITIAL_DELAY_MS);
    }

    private detectProtocol(firstChunk: Buffer): 'v1' | 'v2' | null {
        if (firstChunk.length === 0) {
            return null;
        }

        if (this.looksLikeJsonRpc(firstChunk)) {
            return 'v1';
        }

        // TLS ClientHello. Secure SV1 remains on SECURE_STRATUM_PORTS.
        if (this.looksLikeTlsClientHello(firstChunk)) {
            return null;
        }

        // HTTP on a stratum port is not supported in this branch.
        if (this.looksLikeHttpRequest(firstChunk)) {
            return null;
        }

        // Plaintext that is not JSON-RPC is not a valid SV2 Noise Act 1. This
        // catches PROXY-protocol lines, SSH banners, and malformed SV1 clients
        // before they get misrouted into the SV2 decrypt path.
        if (this.looksLikePlaintext(firstChunk)) {
            return null;
        }

        return 'v2';
    }

    private looksLikeJsonRpc(firstChunk: Buffer): boolean {
        let firstNonWhitespace = -1;
        for (let i = 0; i < firstChunk.length; i++) {
            const byte = firstChunk[i];
            if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
                continue;
            }
            firstNonWhitespace = i;
            break;
        }

        if (firstNonWhitespace < 0 || firstChunk[firstNonWhitespace] !== 0x7b) {
            return false;
        }

        const jsonPrefix = firstChunk
            .subarray(firstNonWhitespace, Math.min(firstChunk.length, firstNonWhitespace + 256))
            .toString('utf8');
        if (jsonPrefix.includes('"method"') || jsonPrefix.includes('"id"')) {
            return true;
        }

        for (const byte of firstChunk) {
            const isWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d;
            const isPrintableAscii = byte >= 0x20 && byte <= 0x7e;
            if (!isWhitespace && !isPrintableAscii) {
                return false;
            }
        }

        return true;
    }

    private looksLikeTlsClientHello(firstChunk: Buffer): boolean {
        return firstChunk.length >= 3
            && firstChunk[0] === 0x16
            && firstChunk[1] === 0x03;
    }

    private looksLikeHttpRequest(firstChunk: Buffer): boolean {
        const prefix = firstChunk.subarray(0, Math.min(firstChunk.length, 8)).toString('ascii').toUpperCase();
        return prefix.startsWith('GET ')
            || prefix.startsWith('POST ')
            || prefix.startsWith('PUT ')
            || prefix.startsWith('PATCH ')
            || prefix.startsWith('HEAD ')
            || prefix.startsWith('OPTIONS ');
    }

    private looksLikePlaintext(firstChunk: Buffer): boolean {
        for (const byte of firstChunk) {
            const isWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d;
            const isPrintableAscii = byte >= 0x20 && byte <= 0x7e;
            if (!isWhitespace && !isPrintableAscii) {
                return false;
            }
        }

        return true;
    }

    private getPositiveIntegerEnv(key: string, fallback: number) {
        const configured = parseInt(process.env[key], 10);
        if (Number.isFinite(configured) && configured > 0) {
            return configured;
        }
        return fallback;

    }


}
