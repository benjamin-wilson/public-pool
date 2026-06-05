import { StratumV1Service } from './stratum-v1.service';

describe('StratumV1Service', () => {
    const originalMaster = process.env.MASTER;
    const originalNodeAppInstance = process.env.NODE_APP_INSTANCE;
    const originalStratumPort = process.env.STRATUM_PORT;
    const originalBackpressureEnabled = process.env.STRATUM_BACKPRESSURE_ENABLED;
    const originalMaxConnectionsPerListener = process.env.STRATUM_MAX_CONNECTIONS_PER_LISTENER;

    let service: StratumV1Service;
    let clientService;
    let consoleLogSpy: jest.SpyInstance;
    let consoleWarnSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.useFakeTimers();
        clientService = {
            deleteAll: jest.fn().mockResolvedValue(undefined)
        };
        service = new StratumV1Service(
            {} as any,
            clientService,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any
        );
        consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        restoreEnv('MASTER', originalMaster);
        restoreEnv('NODE_APP_INSTANCE', originalNodeAppInstance);
        restoreEnv('STRATUM_PORT', originalStratumPort);
        restoreEnv('STRATUM_BACKPRESSURE_ENABLED', originalBackpressureEnabled);
        restoreEnv('STRATUM_MAX_CONNECTIONS_PER_LISTENER', originalMaxConnectionsPerListener);
        consoleLogSpy.mockRestore();
        consoleWarnSpy.mockRestore();
        jest.useRealTimers();
    });

    it('should skip Stratum listeners in the master process', async () => {
        process.env.MASTER = 'true';
        const startSocketServerSpy = jest.spyOn(service as any, 'startSocketServer');

        await service.onModuleInit();
        jest.runOnlyPendingTimers();

        expect(clientService.deleteAll).toHaveBeenCalled();
        expect(startSocketServerSpy).not.toHaveBeenCalled();
        expect(consoleLogSpy).toHaveBeenCalledWith('Master process skipping Stratum socket listeners');
    });

    it('should start the Stratum listener in worker processes', async () => {
        process.env.MASTER = 'false';
        process.env.STRATUM_PORT = '3334';
        const startSocketServerSpy = jest.spyOn(service as any, 'startSocketServer').mockImplementation(() => undefined);

        await service.onModuleInit();
        jest.advanceTimersByTime(10000);

        expect(clientService.deleteAll).not.toHaveBeenCalled();
        expect(startSocketServerSpy).toHaveBeenCalledWith(3334);
    });

    it('should pause listeners when worker backpressure is high', () => {
        const close = jest.fn((callback?: (error?: Error) => void) => callback?.());
        (service as any).listeners.push({
            port: 3333,
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

    function restoreEnv(key: string, value: string | undefined) {
        if (value == null) {
            delete process.env[key];
            return;
        }
        process.env[key] = value;
    }
});
