import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'net';
import { monitorEventLoopDelay } from 'perf_hooks';

import { StratumV1Client } from '../models/StratumV1Client';
import { StratumV2Client } from '../models/StratumV2Client';
import { UserAgentReportService } from '../ORM/_views/user-agent-report/user-agent-report.service';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientService } from '../ORM/client/client.service';
import { ShareAccountingService } from '../ORM/share-accounting/share-accounting.service';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { NotificationService } from './notification.service';
import { RedisMessagingService } from './redis-messaging.service';
import { StratumV1JobsService } from './stratum-v1-jobs.service';
import { StratumV2Service } from './stratum-v2.service';

import { readFileSync } from 'fs';
import { TlsOptions, TLSSocket, createServer } from 'tls';
import * as path from 'path';

interface StratumListenerState {
    port: number;
    secure: boolean;
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



@Injectable()
export class StratumV1Service implements OnModuleInit {

    private socketTimeout = 0;
    private emptySocket = 0;
    private normalClosure = 0;
    private errorClosure = 0;
    private readonly listeners: StratumListenerState[] = [];
    private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
    private backpressureMonitor: NodeJS.Timeout | null = null;
    private healthyBackpressureChecks = 0;

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
        private readonly redisMessagingService?: RedisMessagingService
    ) {

    }

    async onModuleInit(): Promise<void> {

        if (process.env.API_ONLY == 'true') {
            console.log('API-only process skipping Stratum socket listeners');
            return;
        }

        if (process.env.MASTER == 'true') {
            await this.clientService.deleteAll();
            await this.redisMessagingService?.clearClientPresence();
            await this.userAgentReportService.refreshReport();
            console.log('Master process skipping Stratum socket listeners');
            return;
        }

        // wait for all the other processes to init for an even connection distribution 
        setTimeout(() => {
            process.env.STRATUM_PORTS.split(',').forEach(port => {
                this.startSocketServer(parseInt(port));
            });
            if (process.env.STRATUM_SECURE?.toLowerCase() === 'true') {
                process.env.SECURE_STRATUM_PORTS.split(',').forEach(port => {
                    this.startSecureSocketServer(parseInt(port));
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

    private startSocketServer(port: number) {
        const listener: StratumListenerState = {
            port,
            secure: false,
            server: null,
            paused: false
        };
        this.listeners.push(listener);
        this.listen(listener);
    }

    private createSocketServer(): Server {
        const server = new Server(async (socket: Socket) => {
            socket.setTimeout(this.getSocketTimeoutMs());
            socket.setKeepAlive(true, this.getTcpKeepAliveInitialDelayMs());

            let client: StratumV1Client | StratumV2Client = null;
            let protocol: 'v1' | 'v2' | null = null;

            // Unified cleanup function
            const cleanup = async (reason: string) => {
                if (client != null && (protocol === 'v2' || (client as StratumV1Client).extraNonceAndSessionId != null)) {
                    await client.destroy();
                    if (reason == 'Error') {
                        this.errorClosure++;
                    } else {
                        this.normalClosure++;
                    }
                }
                if (!socket.destroyed) {
                    socket.end();
                    socket.destroy();
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
                        client = this.createV1Client(socket);
                        socket.emit('data', firstChunk);
                        return;
                    }

                    if (protocol === 'v2') {
                        await this.stratumV2Service.ensureInitialized();
                        client = this.stratumV2Service.createClient(socket, firstChunk);
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

    private createV1Client(socket: Socket): StratumV1Client {
        return new StratumV1Client(
            socket,
            this.stratumV1JobsService,
            this.bitcoinRpcService,
            this.clientService,
            this.notificationService,
            this.blocksService,
            this.configService,
            this.addressSettingsService,
            this.shareAccountingService,
            this.redisMessagingService
        );
    }

    private startSecureSocketServer(port: number) {
        const listener: StratumListenerState = {
            port,
            secure: true,
            server: null,
            paused: false
        };
        this.listeners.push(listener);
        this.listen(listener);
    }

    private createSecureSocketServer(): Server {

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

            const client = this.createV1Client(socket);

            const cleanup = async (reason: string) => {
                if (client.extraNonceAndSessionId != null) {
                    await client.destroy();
                    if (reason === 'Error') {
                        this.errorClosure++;
                    } else {
                        this.normalClosure++;
                    }
                }
                if (!socket.destroyed) {
                    socket.end();
                    socket.destroy();
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

        const server = listener.secure ? this.createSecureSocketServer() : this.createSocketServer();
        listener.server = server;
        listener.paused = false;

        server.listen(listener.port, () => {
            console.log(`${listener.secure ? 'Stratum TLS' : 'Stratum'} server is listening on port ${listener.port}`);
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
