import { UserAgentReportService } from './user-agent-report.service';

describe('UserAgentReportService', () => {
    const originalApiOnly = process.env.API_ONLY;

    afterEach(() => {
        if (originalApiOnly == null) {
            delete process.env.API_ONLY;
        } else {
            process.env.API_ONLY = originalApiOnly;
        }
    });

    it('uses Redis live presence in API-only processes when workers are connected', async () => {
        process.env.API_ONLY = 'true';
        const userAgentReport = {
            find: jest.fn().mockResolvedValue([
                {
                    userAgent: 'db-view',
                    count: '1',
                    bestDifficulty: 0,
                    totalHashRate: '0',
                },
            ]),
        };
        const clientRepository = {
            find: jest.fn().mockResolvedValue([{ id: 'client-1' }]),
        };
        const redisMessagingService = {
            getJsonCache: jest.fn().mockResolvedValue(null),
            getAllClientPresence: jest.fn().mockResolvedValue([
                {
                    clientId: 'client-1',
                    address: 'tb1qworker',
                    clientName: 'sv2gateway',
                    sessionId: 'session',
                    userAgent: 'unknown/sv2',
                    startTime: '2026-01-01T00:00:00.000Z',
                    lastSeen: '2026-01-01T00:00:10.000Z',
                    hashRate: 123,
                    bestDifficulty: 456,
                },
            ]),
            setJsonCache: jest.fn().mockResolvedValue(undefined),
            removeClientPresence: jest.fn().mockResolvedValue(undefined),
        };
        const service = new UserAgentReportService(
            userAgentReport as any,
            clientRepository as any,
            redisMessagingService as any,
        );

        await expect(service.getReport()).resolves.toEqual([
            {
                userAgent: 'unknown/sv2',
                count: '1',
                bestDifficulty: 456,
                totalHashRate: '123',
            },
        ]);
        expect(userAgentReport.find).not.toHaveBeenCalled();
    });

    it('falls back to the materialized view in API-only processes when live presence is empty', async () => {
        process.env.API_ONLY = 'true';
        const viewRows = [
            {
                userAgent: 'db-view',
                count: '1',
                bestDifficulty: 0,
                totalHashRate: '0',
            },
        ];
        const userAgentReport = {
            find: jest.fn().mockResolvedValue(viewRows),
        };
        const clientRepository = {
            find: jest.fn().mockResolvedValue([]),
        };
        const redisMessagingService = {
            getJsonCache: jest.fn().mockResolvedValue([]),
            getAllClientPresence: jest.fn().mockResolvedValue([]),
            setJsonCache: jest.fn().mockResolvedValue(undefined),
            removeClientPresence: jest.fn().mockResolvedValue(undefined),
        };
        const service = new UserAgentReportService(
            userAgentReport as any,
            clientRepository as any,
            redisMessagingService as any,
        );

        await expect(service.getReport()).resolves.toEqual(viewRows);
    });

    it('filters and removes stale Redis presence rows with no active database client', async () => {
        process.env.API_ONLY = 'true';
        const userAgentReport = {
            find: jest.fn().mockResolvedValue([]),
        };
        const clientRepository = {
            find: jest.fn().mockResolvedValue([{ id: 'active-client' }]),
        };
        const redisMessagingService = {
            getJsonCache: jest.fn().mockResolvedValue(null),
            getAllClientPresence: jest.fn().mockResolvedValue([
                {
                    clientId: 'active-client',
                    address: 'tb1qactive',
                    clientName: 'worker',
                    sessionId: 'active',
                    userAgent: 'bitaxe',
                    startTime: '2026-01-01T00:00:00.000Z',
                    lastSeen: '2026-01-01T00:00:10.000Z',
                    hashRate: 100,
                    bestDifficulty: 200,
                },
                {
                    clientId: 'stale-client',
                    address: 'tb1qstale',
                    clientName: 'worker',
                    sessionId: 'stale',
                    userAgent: 'bitaxe',
                    startTime: '2026-01-01T00:00:00.000Z',
                    lastSeen: '2026-01-01T00:00:10.000Z',
                    hashRate: 300,
                    bestDifficulty: 400,
                },
            ]),
            setJsonCache: jest.fn().mockResolvedValue(undefined),
            removeClientPresence: jest.fn().mockResolvedValue(undefined),
        };
        const service = new UserAgentReportService(
            userAgentReport as any,
            clientRepository as any,
            redisMessagingService as any,
        );

        await expect(service.getReport()).resolves.toEqual([
            {
                userAgent: 'bitaxe',
                count: '1',
                bestDifficulty: 200,
                totalHashRate: '100',
            },
        ]);
        expect(redisMessagingService.removeClientPresence)
            .toHaveBeenCalledWith('stale-client', 'tb1qstale');
    });
});
