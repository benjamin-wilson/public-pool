import { StratumV1Service } from './stratum-v1.service';

describe('StratumV1Service', () => {
    const originalMaster = process.env.MASTER;
    const originalStratumPorts = process.env.STRATUM_PORTS;
    const originalStratumSecure = process.env.STRATUM_SECURE;
    const originalSecureStratumPorts = process.env.SECURE_STRATUM_PORTS;
    const originalBackpressureEnabled = process.env.STRATUM_BACKPRESSURE_ENABLED;
    const originalMaxConnectionsPerListener = process.env.STRATUM_MAX_CONNECTIONS_PER_LISTENER;
    const originalTlsHandshakeTimeoutMs = process.env.STRATUM_TLS_HANDSHAKE_TIMEOUT_MS;

    let service: StratumV1Service;
    let clientService;
    let userAgentReportService;
    let stratumV2Service;
    let redisMessagingService;
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
        redisMessagingService = {
            clearClientPresence: jest.fn().mockResolvedValue(undefined)
        };
        service = new StratumV1Service(
            {} as any,
            clientService,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
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
        expect(redisMessagingService.clearClientPresence).toHaveBeenCalled();
        expect(userAgentReportService.refreshReport).toHaveBeenCalled();
        expect(startSocketServerSpy).not.toHaveBeenCalled();
        expect(startSecureSocketServerSpy).not.toHaveBeenCalled();
        expect(consoleLogSpy).toHaveBeenCalledWith('Master process skipping Stratum socket listeners');
    });

    it('should start Stratum listeners in worker processes', async () => {
        process.env.MASTER = 'false';
        process.env.STRATUM_PORTS = '3333,3334';
        process.env.STRATUM_SECURE = 'true';
        process.env.SECURE_STRATUM_PORTS = '4333';
        const startSocketServerSpy = jest.spyOn(service as any, 'startSocketServer').mockImplementation(() => undefined);
        const startSecureSocketServerSpy = jest.spyOn(service as any, 'startSecureSocketServer').mockImplementation(() => undefined);

        await service.onModuleInit();
        jest.advanceTimersByTime(10000);

        expect(clientService.deleteAll).not.toHaveBeenCalled();
        expect(userAgentReportService.refreshReport).not.toHaveBeenCalled();
        expect(startSocketServerSpy).toHaveBeenCalledWith(3333);
        expect(startSocketServerSpy).toHaveBeenCalledWith(3334);
        expect(startSecureSocketServerSpy).toHaveBeenCalledWith(4333);
    });

    it('should pause listeners when worker backpressure is high', () => {
        const close = jest.fn((callback?: (error?: Error) => void) => callback?.());
        (service as any).listeners.push({
            port: 3333,
            secure: false,
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
