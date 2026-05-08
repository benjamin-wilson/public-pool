import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'net';
import { monitorEventLoopDelay } from 'perf_hooks';

import { StratumV1Client } from '../models/StratumV1Client';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { NotificationService } from './notification.service';
import { StratumV1JobsService } from './stratum-v1-jobs.service';

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
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly notificationService: NotificationService,
        private readonly blocksService: BlocksService,
        private readonly configService: ConfigService,
        private readonly stratumV1JobsService: StratumV1JobsService,
        private readonly addressSettingsService: AddressSettingsService
    ) {

    }

    async onModuleInit(): Promise<void> {

        if (process.env.MASTER == 'true') {
            await this.clientService.deleteAll();
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
            // Set 15-minute timeout
            socket.setTimeout(1000 * 60 * 15);

            const client = new StratumV1Client(
                socket,
                this.stratumV1JobsService,
                this.bitcoinRpcService,
                this.clientService,
                this.clientStatisticsService,
                this.notificationService,
                this.blocksService,
                this.configService,
                this.addressSettingsService
            );

            // Unified cleanup function
            const cleanup = async (reason: string) => {
                if (client.extraNonceAndSessionId != null) {
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

            //


        });

        // Ensure server itself handles errors
        server.on('error', (err) => {
            console.error(`Server error: ${err.message}`);
        });

        return server;
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
        };

        const server = createServer(tlsOptions, async (socket: TLSSocket) => {
            // Set 15-minute timeout
            socket.setTimeout(1000 * 60 * 15);

            const client = new StratumV1Client(
                socket,
                this.stratumV1JobsService,
                this.bitcoinRpcService,
                this.clientService,
                this.clientStatisticsService,
                this.notificationService,
                this.blocksService,
                this.configService,
                this.addressSettingsService
            );

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

    private getPositiveIntegerEnv(key: string, fallback: number) {
        const configured = parseInt(process.env[key], 10);
        if (Number.isFinite(configured) && configured > 0) {
            return configured;
        }
        return fallback;

    }


}
