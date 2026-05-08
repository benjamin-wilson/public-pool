import { StratumV1Service } from './stratum-v1.service';

describe('StratumV1Service', () => {
    const originalMaster = process.env.MASTER;
    const originalStratumPorts = process.env.STRATUM_PORTS;
    const originalStratumSecure = process.env.STRATUM_SECURE;
    const originalSecureStratumPorts = process.env.SECURE_STRATUM_PORTS;

    let service: StratumV1Service;
    let clientService;
    let consoleLogSpy: jest.SpyInstance;

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
            {} as any
        );
        consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
        restoreEnv('MASTER', originalMaster);
        restoreEnv('STRATUM_PORTS', originalStratumPorts);
        restoreEnv('STRATUM_SECURE', originalStratumSecure);
        restoreEnv('SECURE_STRATUM_PORTS', originalSecureStratumPorts);
        consoleLogSpy.mockRestore();
        jest.useRealTimers();
    });

    it('should skip Stratum listeners in the master process', async () => {
        process.env.MASTER = 'true';
        const startSocketServerSpy = jest.spyOn(service as any, 'startSocketServer');
        const startSecureSocketServerSpy = jest.spyOn(service as any, 'startSecureSocketServer');

        await service.onModuleInit();
        jest.runOnlyPendingTimers();

        expect(clientService.deleteAll).toHaveBeenCalled();
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
        expect(startSocketServerSpy).toHaveBeenCalledWith(3333);
        expect(startSocketServerSpy).toHaveBeenCalledWith(3334);
        expect(startSecureSocketServerSpy).toHaveBeenCalledWith(4333);
    });

    function restoreEnv(key: string, value: string | undefined) {
        if (value == null) {
            delete process.env[key];
            return;
        }
        process.env[key] = value;
    }
});
