import { ShareAccountingService } from './share-accounting.service';

describe('ShareAccountingService', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
        process.env = { ...originalEnv };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('should normalize and save accepted share records', async () => {
        const repository = {
            create: jest.fn(value => value),
            insert: jest.fn().mockResolvedValue({}),
        };
        process.env.SHARE_ACCOUNTING_BATCH_SIZE = '1';
        const service = new ShareAccountingService(repository as any);
        const acceptedAt = new Date('2026-06-07T12:00:00Z');

        await expect(service.recordAcceptedShare({
            protocol: 'sv1',
            acceptedAt,
            address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
            clientName: 'worker',
            sessionId: '57a6f098',
            clientId: '6df7beea-921a-46cb-b7dc-e8075f916232',
            jobId: '1',
            jobTemplateId: '2',
            blockHeight: 900000,
            creditedDifficulty: 1024,
            submissionDifficulty: 2048,
            networkDifficulty: 100000,
            nonce: 123,
            ntime: 456,
            version: 536870912,
            extraNonce2: 'c708000000000000',
            isBlockCandidate: false,
            blockSubmissionResult: null,
        })).resolves.toEqual(expect.objectContaining({
            protocol: 'sv1',
            creditedDifficulty: 1024,
        }));

        expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({
            acceptedAt,
            payoutMode: 'solo',
            nonce: '123',
            ntime: '456',
            version: '536870912',
            blockSubmissionResult: null,
        }));
        expect(repository.insert).toHaveBeenCalledWith([expect.objectContaining({
            protocol: 'sv1',
            payoutMode: 'solo',
            creditedDifficulty: 1024,
        })]);
    });

    it('should compact only PPLNS shares into payout rollup batches', async () => {
        process.env.SHARE_ROLLUP_ENABLED = 'true';
        const manager = {
            query: jest.fn()
                .mockResolvedValueOnce([{ locked: true }])
                .mockResolvedValueOnce([{ lastProcessedShareIndex: '10' }])
                .mockResolvedValueOnce([{ startShareIndex: '11', endShareIndex: '20', acceptedShareCount: 10 }])
                .mockResolvedValueOnce([{ startAcceptedAt: new Date('2026-06-14T00:00:00Z'), endAcceptedAt: new Date('2026-06-14T00:01:00Z'), acceptedShareCount: '10', creditedDifficulty: '1000' }])
                .mockResolvedValueOnce([{ batchId: '99' }])
                .mockResolvedValueOnce([]),
        };
        const repository = {
            manager: {
                transaction: jest.fn((callback: any) => callback(manager)),
            },
        };
        const service = new ShareAccountingService(repository as any);

        await expect(service.processPendingShareRollupBatch()).resolves.toEqual(expect.objectContaining({
            processed: true,
            payoutMode: 'pplns',
            batchId: '99',
            startShareIndex: '11',
            endShareIndex: '20',
        }));

        expect(manager.query).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining('"payoutMode" = $1'),
            ['pplns'],
        );
        expect(manager.query).toHaveBeenNthCalledWith(
            3,
            expect.stringContaining('"payoutMode" = $4'),
            ['10', expect.any(Number), expect.any(Number), 'pplns'],
        );
        expect(manager.query).toHaveBeenNthCalledWith(
            6,
            expect.stringContaining('"payoutMode" = $4'),
            ['99', '11', '20', 'pplns'],
        );
    });

    it('should accept TLS SV1 protocol labels for accounting', async () => {
        const repository = {
            create: jest.fn(value => value),
            insert: jest.fn().mockResolvedValue({}),
        };
        process.env.SHARE_ACCOUNTING_BATCH_SIZE = '1';
        const service = new ShareAccountingService(repository as any);

        await expect(service.recordAcceptedShare({
            ...buildRecord('sv1-tls'),
            protocol: 'sv1_tls',
        })).resolves.toEqual(expect.objectContaining({
            protocol: 'sv1_tls',
        }));

        expect(repository.insert).toHaveBeenCalledWith([expect.objectContaining({
            protocol: 'sv1_tls',
        })]);
    });

    it('should batch accepted share inserts until the batch size is reached', async () => {
        process.env.SHARE_ACCOUNTING_BATCH_SIZE = '2';
        process.env.SHARE_ACCOUNTING_FLUSH_INTERVAL_MS = '1000';

        const repository = {
            create: jest.fn(value => value),
            insert: jest.fn().mockResolvedValue({}),
        };
        const service = new ShareAccountingService(repository as any);

        const first = service.recordAcceptedShare(buildRecord('1'));
        expect(repository.insert).not.toHaveBeenCalled();

        const second = service.recordAcceptedShare(buildRecord('2'));
        await expect(Promise.all([first, second])).resolves.toHaveLength(2);

        expect(repository.insert).toHaveBeenCalledTimes(1);
        expect(repository.insert).toHaveBeenCalledWith([
            expect.objectContaining({ jobId: '1' }),
            expect.objectContaining({ jobId: '2' }),
        ]);
    });

    it('should flush partial batches on the flush interval', async () => {
        jest.useFakeTimers();
        process.env.SHARE_ACCOUNTING_BATCH_SIZE = '10';
        process.env.SHARE_ACCOUNTING_FLUSH_INTERVAL_MS = '25';

        const repository = {
            create: jest.fn(value => value),
            insert: jest.fn().mockResolvedValue({}),
        };
        const service = new ShareAccountingService(repository as any);

        const pending = service.recordAcceptedShare(buildRecord('interval'));
        expect(repository.insert).not.toHaveBeenCalled();

        jest.advanceTimersByTime(25);
        await expect(pending).resolves.toEqual(expect.objectContaining({ jobId: 'interval' }));
        expect(repository.insert).toHaveBeenCalledTimes(1);
    });

    it('should reject accepted shares when the accounting queue is full', async () => {
        process.env.SHARE_ACCOUNTING_BATCH_SIZE = '10';
        process.env.SHARE_ACCOUNTING_FLUSH_INTERVAL_MS = '1000';
        process.env.SHARE_ACCOUNTING_MAX_QUEUE_SIZE = '1';

        const repository = {
            create: jest.fn(value => value),
            insert: jest.fn().mockResolvedValue({}),
        };
        const service = new ShareAccountingService(repository as any);

        const queued = service.recordAcceptedShare(buildRecord('queued'));

        await expect(service.recordAcceptedShare(buildRecord('overflow')))
            .rejects
            .toThrow('Share accounting queue is full');
        await service.flushPendingShares();
        await expect(queued).resolves.toEqual(expect.objectContaining({ jobId: 'queued' }));
    });

    it('should return numeric accounting summaries from the share rollup', async () => {
        const repository = {
            query: jest.fn()
                .mockResolvedValueOnce([{
                    totalAcceptedShares: '3',
                    totalCreditedDifficulty: '96',
                    acceptedSharesLast10Minutes: '2',
                    creditedDifficultyLast10Minutes: '64',
                    acceptedSharesLastHour: '3',
                    creditedDifficultyLastHour: '96',
                    acceptedSharesLastDay: '3',
                    creditedDifficultyLastDay: '96',
                    hashRateLast10Minutes: '458129844.9',
                    hashRateLastHour: '114532461.2',
                    latestShareAt: new Date('2026-06-07T12:10:00Z'),
                }]),
        };
        const service = new ShareAccountingService(repository as any);

        await expect(service.getAddressSummary('bc1qtest')).resolves.toEqual({
            totalAcceptedShares: 3,
            totalCreditedDifficulty: 96,
            acceptedSharesLast10Minutes: 2,
            creditedDifficultyLast10Minutes: 64,
            acceptedSharesLastHour: 3,
            creditedDifficultyLastHour: 96,
            acceptedSharesLastDay: 3,
            creditedDifficultyLastDay: 96,
            hashRateLast10Minutes: 458129844.9,
            hashRateLastHour: 114532461.2,
            bestSubmissionDifficulty: 0,
            bestSubmissionDifficultyAt: null,
            workSinceLastBlock: 0,
            currentRoundAcceptedShares: 0,
            currentRoundNetworkDifficulty: 0,
            networkDifficultyPercent: 0,
            blockCandidateCount: 0,
            latestShareAt: '2026-06-07T12:10:00.000Z',
            protocolBreakdown: [],
        });
        expect(repository.query).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining('"accepted_share_10m"'),
            ['bc1qtest'],
        );
        expect(repository.query).toHaveBeenCalledTimes(1);
    });

    it('should serve API-only address accounting from the share rollup instead of empty summaries', async () => {
        process.env.API_ONLY = 'true';
        const repository = {
            query: jest.fn()
                .mockResolvedValueOnce([{
                    totalAcceptedShares: '12',
                    totalCreditedDifficulty: '384',
                    acceptedSharesLast10Minutes: '4',
                    creditedDifficultyLast10Minutes: '128',
                    acceptedSharesLastHour: '10',
                    creditedDifficultyLastHour: '320',
                    acceptedSharesLastDay: '12',
                    creditedDifficultyLastDay: '384',
                    hashRateLast10Minutes: '916259689.8',
                    hashRateLastHour: '381774870.2',
                    latestShareAt: new Date('2026-06-07T12:30:00Z'),
                }]),
        };
        const service = new ShareAccountingService(repository as any);

        await expect(service.getAddressSummary('bc1qapi')).resolves.toEqual(expect.objectContaining({
            totalAcceptedShares: 12,
            totalCreditedDifficulty: 384,
            acceptedSharesLast10Minutes: 4,
            creditedDifficultyLast10Minutes: 128,
            hashRateLast10Minutes: 916259689.8,
            latestShareAt: '2026-06-07T12:30:00.000Z',
        }));
        expect(repository.query).toHaveBeenCalledWith(
            expect.stringContaining('FROM "accepted_share_10m"'),
            ['bc1qapi'],
        );
        expect(repository.query).not.toHaveBeenCalledWith(
            expect.stringContaining('FROM "accepted_share_entity"'),
            expect.anything(),
        );
    });

    it('should serve API-only pool accounting from rollups when the precomputed pool cache is missing', async () => {
        process.env.API_ONLY = 'true';
        const redis = {
            getJsonCache: jest.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(null),
            setJsonCache: jest.fn().mockResolvedValue(undefined),
        };
        const repository = {
            query: jest.fn()
                .mockResolvedValueOnce([{
                    totalAcceptedShares: '12',
                    totalCreditedDifficulty: '384',
                    acceptedSharesLast10Minutes: '4',
                    creditedDifficultyLast10Minutes: '128',
                    acceptedSharesLastHour: '10',
                    creditedDifficultyLastHour: '320',
                    acceptedSharesLastDay: '12',
                    creditedDifficultyLastDay: '384',
                    hashRateLast10Minutes: '916259689.8',
                    hashRateLastHour: '381774870.2',
                    latestShareAt: new Date('2026-06-07T12:30:00Z'),
                }])
                .mockResolvedValueOnce([{
                    bestSubmissionDifficulty: '4096',
                    bestSubmissionDifficultyAt: new Date('2026-06-07T12:20:00Z'),
                    currentRoundAcceptedShares: '11',
                    workSinceLastBlock: '352',
                    currentRoundNetworkDifficulty: '1000',
                }])
                .mockResolvedValueOnce([]),
        };
        const service = new ShareAccountingService(repository as any, redis as any);

        await expect(service.getPoolSummary('solo')).resolves.toEqual(expect.objectContaining({
            totalAcceptedShares: 12,
            totalCreditedDifficulty: 384,
            acceptedSharesLast10Minutes: 4,
            creditedDifficultyLast10Minutes: 128,
            bestSubmissionDifficulty: 4096,
            workSinceLastBlock: 352,
            networkDifficultyPercent: 35.2,
        }));

        expect(repository.query).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining('FROM "accepted_share_pool_10m"'),
            ['solo'],
        );
        expect(repository.query).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining('FROM "accepted_share_block_10m"'),
            ['solo'],
        );
    });

    it('should use Redis cache for share accounting summaries across API workers', async () => {
        process.env.SHARE_ACCOUNTING_SUMMARY_CACHE_MS = '0';
        const repository = {
            query: jest.fn()
                .mockResolvedValueOnce([{
                    totalAcceptedShares: '1',
                    totalCreditedDifficulty: '32',
                    acceptedSharesLast10Minutes: '1',
                    creditedDifficultyLast10Minutes: '32',
                    acceptedSharesLastHour: '1',
                    creditedDifficultyLastHour: '32',
                    acceptedSharesLastDay: '1',
                    creditedDifficultyLastDay: '32',
                    hashRateLast10Minutes: '1',
                    hashRateLastHour: '1',
                    latestShareAt: null,
                }]),
        };
        const redis = {
            getJsonCache: jest.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({
                    ...new ShareAccountingService(repository as any).emptySummary(),
                    totalAcceptedShares: 1,
                }),
            setJsonCache: jest.fn().mockResolvedValue(undefined),
        };
        const service = new ShareAccountingService(repository as any, redis as any);

        await service.getAddressSummary('bc1qcached');
        await expect(service.getAddressSummary('bc1qcached')).resolves.toEqual(expect.objectContaining({
            totalAcceptedShares: 1,
        }));

        expect(repository.query).toHaveBeenCalledTimes(1);
        expect(redis.setJsonCache).toHaveBeenCalledWith(
            expect.stringContaining('accounting:summary:'),
            expect.objectContaining({
                schemaVersion: 1,
                refreshedAtMs: expect.any(Number),
                value: expect.objectContaining({ totalAcceptedShares: 1 }),
            }),
            3600000,
        );
    });

    it('serves a stale shared summary while one API worker refreshes it', async () => {
        process.env.SHARE_ACCOUNTING_SUMMARY_CACHE_MS = '0';
        process.env.SHARE_ACCOUNTING_REDIS_SUMMARY_CACHE_MS = '100';
        const staleSummary = {
            ...new ShareAccountingService({} as any).emptySummary(),
            totalAcceptedShares: 7,
        };
        const repository = {
            query: jest.fn().mockResolvedValueOnce([{
                totalAcceptedShares: '8',
                totalCreditedDifficulty: '256',
                acceptedSharesLast10Minutes: '1',
                creditedDifficultyLast10Minutes: '32',
                acceptedSharesLastHour: '8',
                creditedDifficultyLastHour: '256',
                acceptedSharesLastDay: '8',
                creditedDifficultyLastDay: '256',
                hashRateLast10Minutes: '1',
                hashRateLastHour: '1',
                latestShareAt: null,
            }]),
        };
        const redis = {
            getJsonCache: jest.fn().mockResolvedValue({
                schemaVersion: 1,
                refreshedAtMs: Date.now() - 1000,
                value: staleSummary,
            }),
            setJsonCache: jest.fn().mockResolvedValue(undefined),
            tryAcquireJsonCacheLock: jest.fn().mockResolvedValue(true),
            releaseJsonCacheLock: jest.fn().mockResolvedValue(undefined),
        };
        const service = new ShareAccountingService(repository as any, redis as any);

        await expect(service.getAddressSummary('bc1qstale')).resolves.toEqual(staleSummary);
        await new Promise(resolve => setImmediate(resolve));

        expect(repository.query).toHaveBeenCalledTimes(1);
        expect(redis.tryAcquireJsonCacheLock).toHaveBeenCalledTimes(1);
        expect(redis.setJsonCache).toHaveBeenCalledWith(
            expect.stringContaining('accounting:summary:'),
            expect.objectContaining({
                schemaVersion: 1,
                value: expect.objectContaining({ totalAcceptedShares: 8 }),
            }),
            3600000,
        );
        expect(redis.releaseJsonCacheLock).toHaveBeenCalledTimes(1);
    });

    it('should refresh pool summaries from completed rollup buckets and current round rollups', async () => {
        const redis = {
            getJsonCache: jest.fn().mockResolvedValue(null),
            setJsonCache: jest.fn().mockResolvedValue(undefined),
        };
        const repository = {
            query: jest.fn()
                .mockResolvedValueOnce([{
                    totalAcceptedShares: '3',
                    totalCreditedDifficulty: '96',
                    acceptedSharesLast10Minutes: '2',
                    creditedDifficultyLast10Minutes: '64',
                    acceptedSharesLastHour: '3',
                    creditedDifficultyLastHour: '96',
                    acceptedSharesLastDay: '3',
                    creditedDifficultyLastDay: '96',
                    hashRateLast10Minutes: '458129844.9',
                    hashRateLastHour: '114532461.2',
                    latestShareAt: new Date('2026-06-07T12:10:00Z'),
                }])
                .mockResolvedValueOnce([{
                    bestSubmissionDifficulty: '4096',
                    bestSubmissionDifficultyAt: new Date('2026-06-07T12:10:00Z'),
                    currentRoundAcceptedShares: '11',
                    workSinceLastBlock: '352',
                    currentRoundNetworkDifficulty: '1000',
                }])
                .mockResolvedValueOnce([]),
        };
        const service = new ShareAccountingService(repository as any, redis as any);

        await expect(service.refreshPoolSummary()).resolves.toEqual(expect.objectContaining({
            acceptedSharesLast10Minutes: 2,
            creditedDifficultyLast10Minutes: 64,
            hashRateLast10Minutes: 458129844.9,
            bestSubmissionDifficulty: 4096,
            bestSubmissionDifficultyAt: '2026-06-07T12:10:00.000Z',
            workSinceLastBlock: 352,
            currentRoundAcceptedShares: 11,
            currentRoundNetworkDifficulty: 1000,
            networkDifficultyPercent: 35.2,
            latestShareAt: '2026-06-07T12:10:00.000Z',
        }));
        expect(repository.query).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining('FROM "accepted_share_pool_10m"'),
            [],
        );
        expect(repository.query).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining('FROM "accepted_share_block_10m"'),
            [],
        );
        expect(repository.query).toHaveBeenNthCalledWith(
            3,
            expect.stringContaining('FROM "accepted_share_high_score"'),
            ['all'],
        );
        expect(repository.query).not.toHaveBeenCalledWith(
            expect.stringContaining('FROM "accepted_share_entity"'),
        );
    });

    it('should retain best submitted share after raw share retention removes older rows', async () => {
        const repository = {
            query: jest.fn()
                .mockResolvedValueOnce([{
                    totalAcceptedShares: '3',
                    totalCreditedDifficulty: '96',
                    acceptedSharesLast10Minutes: '2',
                    creditedDifficultyLast10Minutes: '64',
                    acceptedSharesLastHour: '3',
                    creditedDifficultyLastHour: '96',
                    acceptedSharesLastDay: '3',
                    creditedDifficultyLastDay: '96',
                    hashRateLast10Minutes: '458129844.9',
                    hashRateLastHour: '114532461.2',
                    latestShareAt: new Date('2026-06-07T12:10:00Z'),
                }])
                .mockResolvedValueOnce([{
                    bestSubmissionDifficulty: '4096',
                    bestSubmissionDifficultyAt: new Date('2026-06-07T12:10:00Z'),
                    currentRoundAcceptedShares: '11',
                    workSinceLastBlock: '352',
                    currentRoundNetworkDifficulty: '1000',
                }])
                .mockResolvedValueOnce([{
                    bestSubmissionDifficulty: '8192',
                    bestSubmissionDifficultyAt: new Date('2026-06-01T12:10:00Z'),
                }]),
        };
        const service = new ShareAccountingService(repository as any);

        await expect(service.refreshPoolSummary()).resolves.toEqual(expect.objectContaining({
            bestSubmissionDifficulty: 8192,
            bestSubmissionDifficultyAt: '2026-06-01T12:10:00.000Z',
            workSinceLastBlock: 352,
        }));
    });

    it('should cache accounting summaries briefly to protect hot dashboard endpoints', async () => {
        process.env.SHARE_ACCOUNTING_SUMMARY_CACHE_MS = '1000';
        const repository = {
            query: jest.fn()
                .mockResolvedValueOnce([{
                    totalAcceptedShares: '1',
                    totalCreditedDifficulty: '32',
                    acceptedSharesLast10Minutes: '1',
                    creditedDifficultyLast10Minutes: '32',
                    acceptedSharesLastHour: '1',
                    creditedDifficultyLastHour: '32',
                    acceptedSharesLastDay: '1',
                    creditedDifficultyLastDay: '32',
                    hashRateLast10Minutes: '1',
                    hashRateLastHour: '1',
                    latestShareAt: null,
                }]),
        };
        const service = new ShareAccountingService(repository as any);

        await service.getAddressSummary('bc1qcached');
        await service.getAddressSummary('bc1qcached');

        expect(repository.query).toHaveBeenCalledTimes(1);
    });

    it('should finalize accepted shares into an append-only share rollup batch', async () => {
        const manager = {
            query: jest.fn()
                .mockResolvedValueOnce([{ locked: true }])
                .mockResolvedValueOnce([{ lastProcessedShareIndex: '10' }])
                .mockResolvedValueOnce([{ startShareIndex: '11', endShareIndex: '20', acceptedShareCount: 10 }])
                .mockResolvedValueOnce([{
                    startAcceptedAt: new Date('2026-06-07T12:00:00Z'),
                    endAcceptedAt: new Date('2026-06-07T12:00:30Z'),
                    acceptedShareCount: '10',
                    creditedDifficulty: '2048',
                }])
                .mockResolvedValueOnce([{ batchId: '7' }])
                .mockResolvedValueOnce([]),
        };
        const repository = {
            manager: {
                transaction: jest.fn(callback => callback(manager)),
            },
        };
        const service = new ShareAccountingService(repository as any);

        await expect(service.processPendingShareRollupBatch()).resolves.toEqual({
            processed: true,
            payoutMode: 'pplns',
            batchId: '7',
            startShareIndex: '11',
            endShareIndex: '20',
            acceptedShareCount: 10,
            creditedDifficulty: 2048,
        });

        expect(repository.manager.transaction).toHaveBeenCalledTimes(1);
        expect(manager.query).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining('pg_try_advisory_xact_lock'),
            ['1780962600'],
        );
        expect(manager.query).toHaveBeenNthCalledWith(
            6,
            expect.stringContaining('INSERT INTO "share_rollup_batch_summary"'),
            ['7', '11', '20', 'pplns'],
        );
    });

    it('should skip share rollup work when another process holds the advisory lock', async () => {
        const manager = {
            query: jest.fn().mockResolvedValueOnce([{ locked: false }]),
        };
        const repository = {
            manager: {
                transaction: jest.fn(callback => callback(manager)),
            },
        };
        const service = new ShareAccountingService(repository as any);

        await expect(service.processPendingShareRollupBatch()).resolves.toEqual({
            processed: false,
            reason: 'locked',
        });

        expect(manager.query).toHaveBeenCalledTimes(1);
    });
});

function buildRecord(jobId: string) {
    return {
        protocol: 'sv1' as const,
        acceptedAt: new Date('2026-06-07T12:00:00Z'),
        address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
        clientName: 'worker',
        sessionId: '57a6f098',
        clientId: '6df7beea-921a-46cb-b7dc-e8075f916232',
        jobId,
        jobTemplateId: 'template',
        blockHeight: 900000,
        creditedDifficulty: 1024,
        submissionDifficulty: 2048,
        networkDifficulty: 100000,
        nonce: 123,
        ntime: 456,
        version: 536870912,
        extraNonce2: 'c708000000000000',
        isBlockCandidate: false,
        blockSubmissionResult: null,
    };
}
