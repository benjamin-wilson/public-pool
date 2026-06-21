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

    it('uses active database clients for live API-only reports', async () => {
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
        const clientRepository = createClientRepository([
            {
                userAgent: 'unknown/sv2',
                count: '1',
                bestDifficulty: 456,
                totalHashRate: '123',
            },
        ]);
        const redisMessagingService = {
            getJsonCache: jest.fn().mockResolvedValue(null),
            setJsonCache: jest.fn().mockResolvedValue(undefined),
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
        expect(clientRepository.createQueryBuilder).toHaveBeenCalled();
        expect(clientRepository.queryBuilder.andWhere).toHaveBeenCalledWith(
            'client.updatedAt > :activeSince',
            expect.objectContaining({ activeSince: expect.any(Date) }),
        );
        expect(clientRepository.queryBuilder.andWhere).toHaveBeenCalledWith('client.hashRate > 0');
    });

    it('falls back to the materialized view when no active database clients exist', async () => {
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
        const clientRepository = createClientRepository([]);
        const redisMessagingService = {
            getJsonCache: jest.fn().mockResolvedValue([]),
            setJsonCache: jest.fn().mockResolvedValue(undefined),
        };
        const service = new UserAgentReportService(
            userAgentReport as any,
            clientRepository as any,
            redisMessagingService as any,
        );

        await expect(service.getReport()).resolves.toEqual(viewRows);
    });

    it('returns a non-empty cached live report before querying the database', async () => {
        process.env.API_ONLY = 'true';
        const cachedRows = [
            {
                userAgent: 'cached',
                count: '2',
                bestDifficulty: 8,
                totalHashRate: '16',
            },
        ];
        const userAgentReport = {
            find: jest.fn(),
        };
        const clientRepository = createClientRepository([]);
        const redisMessagingService = {
            getJsonCache: jest.fn().mockResolvedValue(cachedRows),
            setJsonCache: jest.fn().mockResolvedValue(undefined),
        };
        const service = new UserAgentReportService(
            userAgentReport as any,
            clientRepository as any,
            redisMessagingService as any,
        );

        await expect(service.getReport()).resolves.toEqual(cachedRows);
        expect(clientRepository.createQueryBuilder).not.toHaveBeenCalled();
    });
});

function createClientRepository(rows: unknown[]) {
    const queryBuilder = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(rows),
    };

    return {
        createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
        queryBuilder,
    };
}
