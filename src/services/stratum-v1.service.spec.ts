import { Subject } from 'rxjs';

import { StratumV1Service } from './stratum-v1.service';

describe('StratumV1Service', () => {
    const originalMaster = process.env.MASTER;
    const originalStratumPorts = process.env.STRATUM_PORTS;
    const originalStratumSecure = process.env.STRATUM_SECURE;
    const originalSecureStratumPorts = process.env.SECURE_STRATUM_PORTS;
    const originalBackpressureEnabled = process.env.STRATUM_BACKPRESSURE_ENABLED;
    const originalMaxConnectionsPerListener = process.env.STRATUM_MAX_CONNECTIONS_PER_LISTENER;
    const originalTlsHandshakeTimeoutMs = process.env.STRATUM_TLS_HANDSHAKE_TIMEOUT_MS;
    const originalSocketTimeoutMs = process.env.STRATUM_SOCKET_TIMEOUT_MS;
    const originalTcpKeepAliveInitialDelayMs = process.env.STRATUM_TCP_KEEPALIVE_INITIAL_DELAY_MS;
    const originalFanoutTargetClientsPerWorker = process.env.STRATUM_FANOUT_TARGET_CLIENTS_PER_WORKER;

    let service: StratumV1Service;
    let clientService;
    let userAgentReportService;
    let stratumV2Service;
    let redisMessagingService;
    let miningJobs: Subject<any>;
    let prestageJobs: Subject<any>;
    let prestageActivations: Subject<any>;
    let consoleLogSpy: jest.SpyInstance;
    let consoleWarnSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.useFakeTimers();
        clientService = {
            deleteAll: jest.fn().mockResolvedValue(undefined)
        };
        userAgentReportService = {
            refreshReport: jest.fn().mockResolvedValue(undefined)
        };
        stratumV2Service = {
            ensureInitialized: jest.fn().mockResolvedValue(undefined),
            createClient: jest.fn()
        };
        redisMessagingService = {};
        miningJobs = new Subject();
        prestageJobs = new Subject();
        prestageActivations = new Subject();
        service = new StratumV1Service(
            { newSv1PrestageActivation$: prestageActivations.asObservable() } as any,
            clientService,
            {} as any,
            {} as any,
            {} as any,
            {
                newMiningJob$: miningJobs.asObservable(),
                sv1PrestageJob$: prestageJobs.asObservable(),
            } as any,
            {} as any,
            stratumV2Service as any,
            userAgentReportService as any,
            undefined,
            redisMessagingService as any
        );
        consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        restoreEnv('MASTER', originalMaster);
        restoreEnv('STRATUM_PORTS', originalStratumPorts);
        restoreEnv('STRATUM_SECURE', originalStratumSecure);
        restoreEnv('SECURE_STRATUM_PORTS', originalSecureStratumPorts);
        restoreEnv('STRATUM_BACKPRESSURE_ENABLED', originalBackpressureEnabled);
        restoreEnv('STRATUM_MAX_CONNECTIONS_PER_LISTENER', originalMaxConnectionsPerListener);
        restoreEnv('STRATUM_TLS_HANDSHAKE_TIMEOUT_MS', originalTlsHandshakeTimeoutMs);
        restoreEnv('STRATUM_SOCKET_TIMEOUT_MS', originalSocketTimeoutMs);
        restoreEnv('STRATUM_TCP_KEEPALIVE_INITIAL_DELAY_MS', originalTcpKeepAliveInitialDelayMs);
        restoreEnv('STRATUM_FANOUT_TARGET_CLIENTS_PER_WORKER', originalFanoutTargetClientsPerWorker);
        consoleLogSpy.mockRestore();
        consoleWarnSpy.mockRestore();
        jest.useRealTimers();
    });

    it('should skip Stratum listeners in the master process', async () => {
        process.env.MASTER = 'true';
        const startSocketServerSpy = jest.spyOn(service as any, 'startSocketServer');
        const startSecureSocketServerSpy = jest.spyOn(service as any, 'startSecureSocketServer');

        await service.onModuleInit();
        jest.runOnlyPendingTimers();

        expect(clientService.deleteAll).toHaveBeenCalled();
        expect(userAgentReportService.refreshReport).toHaveBeenCalled();
        expect(startSocketServerSpy).not.toHaveBeenCalled();
        expect(startSecureSocketServerSpy).not.toHaveBeenCalled();
        expect(consoleLogSpy).toHaveBeenCalledWith('Master process skipping Stratum socket listeners');
    });

    it('should start Stratum listeners in worker processes', async () => {
        process.env.MASTER = 'false';
        process.env.STRATUM_PORTS = '3333,3334';
        process.env.PPLNS_STRATUM_PORTS = '13333';
        process.env.STRATUM_SECURE = 'true';
        process.env.SECURE_STRATUM_PORTS = '4333';
        process.env.PPLNS_SECURE_STRATUM_PORTS = '14333';
        const startSocketServerSpy = jest.spyOn(service as any, 'startSocketServer').mockImplementation(() => undefined);
        const startSecureSocketServerSpy = jest.spyOn(service as any, 'startSecureSocketServer').mockImplementation(() => undefined);

        await service.onModuleInit();
        jest.advanceTimersByTime(10000);

        expect(clientService.deleteAll).not.toHaveBeenCalled();
        expect(userAgentReportService.refreshReport).not.toHaveBeenCalled();
        expect(startSocketServerSpy).toHaveBeenCalledWith(3333, 'solo');
        expect(startSocketServerSpy).toHaveBeenCalledWith(3334, 'solo');
        expect(startSocketServerSpy).toHaveBeenCalledWith(13333, 'pplns');
        expect(startSecureSocketServerSpy).toHaveBeenCalledWith(4333, 'solo');
        expect(startSecureSocketServerSpy).toHaveBeenCalledWith(14333, 'pplns');
    });

    it('should fan out each job once through the worker broadcaster', async () => {
        process.env.MASTER = 'false';
        process.env.STRATUM_PORTS = '';
        process.env.STRATUM_SECURE = 'false';
        const client = {
            broadcastMiningJob: jest.fn().mockReturnValue({
                status: 'written',
                bytes: 500,
                bufferedBytes: 0,
            }),
        };
        (service as any).clients.add(client);
        await service.onModuleInit();

        const job = {
            blockData: {
                id: 'a',
                height: 900001,
                jobType: 'full',
                isNewBlock: true,
                clearJobs: true,
            },
        };
        miningJobs.next(job);

        expect(client.broadcastMiningJob).toHaveBeenCalledTimes(1);
        expect(client.broadcastMiningJob).toHaveBeenCalledWith(job);
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('stratum_job_fanout'));
        service.onModuleDestroy();
    });

    it('enqueues a 100,000-client fanout without per-client async serialization', () => {
        process.env.STRATUM_FANOUT_TARGET_CLIENTS_PER_WORKER = '10000';
        const clientCount = 100_000;
        let writes = 0;
        const broadcastMiningJob = () => {
            writes++;
            return { status: 'written', bytes: 256, bufferedBytes: 0 };
        };
        for (let index = 0; index < clientCount; index++) {
            (service as any).clients.add({ broadcastMiningJob });
        }
        const job = {
            blockData: {
                id: 'load',
                height: 900001,
                jobType: 'empty',
                isNewBlock: true,
                clearJobs: true,
                notificationEventId: 'load-test',
                notificationPublishedAtMs: Date.now(),
            },
        };

        (service as any).broadcastMiningJob(job);

        const trace = JSON.parse(consoleLogSpy.mock.calls.at(-1)?.[0]);
        expect(writes).toBe(clientCount);
        expect(trace).toEqual(expect.objectContaining({
            event: 'stratum_job_fanout',
            eventId: 'load-test',
            clients: clientCount,
            targetClientsPerWorker: 10_000,
            overTargetClients: 90_000,
            written: clientCount,
        }));
        expect(trace.milestoneMs).toEqual(expect.objectContaining({
            p50: expect.any(Number),
            p95: expect.any(Number),
            p99: expect.any(Number),
        }));
        expect(trace.totalMs).toBeLessThan(1_000);
    });

    it('pre-stages next-height jobs for connected miners without broadcasting them', async () => {
        process.env.MASTER = 'false';
        process.env.STRATUM_PORTS = '';
        process.env.STRATUM_SECURE = 'false';
        const clients = Array.from({ length: 3 }, () => ({
            preStageMiningJob: jest.fn().mockReturnValue(true),
            broadcastMiningJob: jest.fn(),
        }));
        clients.forEach(client => (service as any).clients.add(client));
        await service.onModuleInit();
        const prestage = {
            blockData: {
                id: 'prestage-2',
                height: 900002,
                payoutMode: 'solo',
                notificationEventId: 'prestage-event',
            },
        };

        prestageJobs.next(prestage);
        await Promise.resolve();

        clients.forEach(client => {
            expect(client.preStageMiningJob).toHaveBeenCalledWith(prestage);
            expect(client.broadcastMiningJob).not.toHaveBeenCalled();
        });
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('sv1_job_prestage'));
        service.onModuleDestroy();
    });

    it('promotes and broadcasts compact prestage activations immediately', async () => {
        process.env.MASTER = 'false';
        process.env.STRATUM_PORTS = '';
        process.env.STRATUM_SECURE = 'false';
        const activatedJob = {
            blockData: {
                id: 'activated-2',
                height: 900002,
                tipKey: `900002:${'55'.repeat(32)}`,
                payoutMode: 'solo',
                jobType: 'empty',
                isNewBlock: true,
                clearJobs: true,
                notificationEventId: 'activate-2',
            },
        };
        const activateLatestPrestage = jest.fn().mockReturnValue(activatedJob);
        (service as any).stratumV1JobsService.activateLatestPrestage = activateLatestPrestage;
        const client = {
            broadcastMiningJob: jest.fn().mockReturnValue({
                status: 'written',
                bytes: 256,
                bufferedBytes: 0,
                preStaged: true,
            }),
        };
        (service as any).clients.add(client);
        await service.onModuleInit();
        const activation = {
            eventId: 'activate-2',
            height: 900002,
            payoutMode: 'solo',
            previousBlockHash: '55'.repeat(32),
        };

        prestageActivations.next(activation);

        expect(activateLatestPrestage).toHaveBeenCalledWith(activation);
        expect(client.broadcastMiningJob).toHaveBeenCalledWith(activatedJob);
        service.onModuleDestroy();
    });

    it('does not log routine non-new-block fanout unless explicitly enabled', () => {
        (service as any).clients.add({
            broadcastMiningJob: jest.fn().mockReturnValue({
                status: 'written',
                bytes: 256,
                bufferedBytes: 0,
            }),
        });
        const job = {
            blockData: {
                id: 'routine',
                height: 900001,
                jobType: 'full',
                isNewBlock: false,
                clearJobs: false,
            },
        };

        (service as any).broadcastMiningJob(job);

        expect(consoleLogSpy.mock.calls.some(call => call[0]?.includes('stratum_job_fanout'))).toBe(false);
    });

    it('reports a buffer-limited client as closed without counting an unwritten job', () => {
        (service as any).clients.add({
            broadcastMiningJob: jest.fn().mockReturnValue({
                status: 'closed',
                bytes: 0,
                bufferedBytes: 262_144,
            }),
        });
        const job = {
            blockData: {
                id: 'buffer-limit',
                height: 900001,
                jobType: 'empty',
                isNewBlock: true,
                clearJobs: true,
            },
        };

        (service as any).broadcastMiningJob(job);

        const trace = JSON.parse(consoleLogSpy.mock.calls.at(-1)?.[0]);
        expect(trace).toEqual(expect.objectContaining({
            clients: 1,
            closed: 1,
            written: 0,
            backpressured: 0,
            bytesQueued: 0,
            maxBufferedBytes: 262_144,
        }));
    });

    it('should pause listeners when worker backpressure is high', () => {
        const close = jest.fn((callback?: (error?: Error) => void) => callback?.());
        (service as any).listeners.push({
            port: 3333,
            secure: false,
            payoutMode: 'solo',
            server: { close },
            paused: false
        });
        jest.spyOn(service as any, 'getEventLoopP95Ms').mockReturnValue(5000);
        jest.spyOn(service as any, 'getBackpressureEventLoopP95Ms').mockReturnValue(2000);

        (service as any).checkBackpressure();

        expect(close).toHaveBeenCalled();
        expect((service as any).listeners[0].paused).toBe(true);
        expect((service as any).listeners[0].server).toBeNull();
        expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Pausing Stratum accepts'));
    });

    it('should resume listeners after consecutive healthy backpressure checks', () => {
        (service as any).listeners.push({
            port: 3333,
            secure: false,
            server: null,
            paused: true
        });
        jest.spyOn(service as any, 'getEventLoopP95Ms').mockReturnValue(50);
        jest.spyOn(service as any, 'getBackpressureEventLoopP95Ms').mockReturnValue(2000);
        jest.spyOn(service as any, 'getBackpressureResumeEventLoopP95Ms').mockReturnValue(250);
        jest.spyOn(service as any, 'getBackpressureResumeRssMb').mockReturnValue(Number.MAX_SAFE_INTEGER);
        jest.spyOn(service as any, 'getBackpressureHealthyChecks').mockReturnValue(2);
        const listenSpy = jest.spyOn(service as any, 'listen').mockImplementation((listener: any) => {
            listener.server = {};
            listener.paused = false;
        });

        (service as any).checkBackpressure();
        expect(listenSpy).not.toHaveBeenCalled();

        (service as any).checkBackpressure();

        expect(listenSpy).toHaveBeenCalledWith((service as any).listeners[0]);
        expect((service as any).listeners[0].paused).toBe(false);
        expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Resuming Stratum accepts'));
    });

    it('should cap listener connections and drop excess cluster connections', () => {
        process.env.STRATUM_MAX_CONNECTIONS_PER_LISTENER = '250';
        const server = {} as any;

        (service as any).configureConnectionLimit(server);

        expect(server.maxConnections).toBe(250);
        expect(server.dropMaxConnection).toBe(true);
    });

    it('should allow high-volume pools by default', () => {
        delete process.env.STRATUM_MAX_CONNECTIONS_PER_LISTENER;

        expect((service as any).getMaxConnectionsPerListener()).toBe(10000);
    });

    it('should use an explicit TLS handshake timeout', () => {
        process.env.STRATUM_TLS_HANDSHAKE_TIMEOUT_MS = '5000';

        expect((service as any).getTlsHandshakeTimeoutMs()).toBe(5000);
    });

    it('should keep quiet miners connected for one hour by default', () => {
        delete process.env.STRATUM_SOCKET_TIMEOUT_MS;

        expect((service as any).getSocketTimeoutMs()).toBe(1000 * 60 * 60);
    });

    it('should allow configuring Stratum socket idle timeout', () => {
        process.env.STRATUM_SOCKET_TIMEOUT_MS = '7200000';

        expect((service as any).getSocketTimeoutMs()).toBe(7200000);
    });

    it('should enable TCP keepalive quickly by default', () => {
        delete process.env.STRATUM_TCP_KEEPALIVE_INITIAL_DELAY_MS;

        expect((service as any).getTcpKeepAliveInitialDelayMs()).toBe(60000);
    });

    it('should allow configuring TCP keepalive initial delay', () => {
        process.env.STRATUM_TCP_KEEPALIVE_INITIAL_DELAY_MS = '30000';

        expect((service as any).getTcpKeepAliveInitialDelayMs()).toBe(30000);
    });

    it('should detect JSON-RPC as Stratum V1', () => {
        const firstChunk = Buffer.from('{"id":1,"method":"mining.subscribe","params":[]}\n');

        expect((service as any).detectProtocol(firstChunk)).toBe('v1');
    });

    it('should detect JSON-RPC as Stratum V1 even with non-printable trailing bytes', () => {
        const firstChunk = Buffer.concat([
            Buffer.from('{"id": 1, "method": "mining.subscribe", "params": []}\n'),
            Buffer.from([0x00, 0xff])
        ]);

        expect((service as any).detectProtocol(firstChunk)).toBe('v1');
    });

    it('should detect binary Noise traffic as Stratum V2', () => {
        const firstChunk = Buffer.concat([
            Buffer.from([0x01, 0x02, 0x03, 0x04]),
            Buffer.alloc(60, 0xaa)
        ]);

        expect((service as any).detectProtocol(firstChunk)).toBe('v2');
    });

    it('should reject recognizable TLS client hello on the unified plain stratum port', () => {
        expect((service as any).detectProtocol(Buffer.from([0x16, 0x03, 0x01]))).toBeNull();
    });

    it('should route binary data that only shares a TLS first byte to Stratum V2', () => {
        expect((service as any).detectProtocol(Buffer.from([0x16, 0xaa, 0xbb]))).toBe('v2');
    });

    it('should not route plaintext PROXY protocol headers to Stratum V2', () => {
        const firstChunk = Buffer.from('PROXY TCP4 203.0.113.10 192.0.2.10 54321 3333\\r\\n');

        expect((service as any).detectProtocol(firstChunk)).toBeNull();
    });

    it('should not route malformed plaintext to Stratum V2', () => {
        expect((service as any).detectProtocol(Buffer.from('mining.subscribe\\n'))).toBeNull();
    });

    function restoreEnv(key: string, value: string | undefined) {
        if (value == null) {
            delete process.env[key];
            return;
        }
        process.env[key] = value;
    }
});
