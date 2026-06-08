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
            nonce: '123',
            ntime: '456',
            version: '536870912',
            blockSubmissionResult: null,
        }));
        expect(repository.insert).toHaveBeenCalledWith([expect.objectContaining({
            protocol: 'sv1',
            creditedDifficulty: 1024,
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

    it('should overlay live pool data and best share from the current round', async () => {
        const redis = {
            setJsonCache: jest.fn().mockResolvedValue(undefined),
        };
        const repository = {
            query: jest.fn()
                .mockResolvedValueOnce([{
                    totalAcceptedShares: '3',
                    totalCreditedDifficulty: '96',
                    acceptedSharesLast10Minutes: '0',
                    creditedDifficultyLast10Minutes: '0',
                    acceptedSharesLastHour: '3',
                    creditedDifficultyLastHour: '96',
                    acceptedSharesLastDay: '3',
                    creditedDifficultyLastDay: '96',
                    hashRateLast10Minutes: '0',
                    hashRateLastHour: '114532461.2',
                    latestShareAt: new Date('2026-06-07T12:10:00Z'),
                }])
                .mockResolvedValueOnce([{
                    acceptedSharesLast10Minutes: '7',
                    creditedDifficultyLast10Minutes: '224',
                    hashRateLast10Minutes: '1603451170.77',
                    latestShareAt: new Date('2026-06-07T12:20:00Z'),
                }])
                .mockResolvedValueOnce([{
                    bestSubmissionDifficulty: '4096',
                    bestSubmissionDifficultyAt: new Date('2026-06-07T12:19:00Z'),
                }]),
        };
        const service = new ShareAccountingService(repository as any, redis as any);

        await expect(service.refreshPoolSummary()).resolves.toEqual(expect.objectContaining({
            acceptedSharesLast10Minutes: 7,
            creditedDifficultyLast10Minutes: 224,
            hashRateLast10Minutes: 1603451170.77,
            bestSubmissionDifficulty: 4096,
            bestSubmissionDifficultyAt: '2026-06-07T12:19:00.000Z',
            latestShareAt: '2026-06-07T12:20:00.000Z',
        }));
        expect(repository.query).toHaveBeenNthCalledWith(
            3,
            expect.stringContaining('WHERE "blockHeight" > latest_found_block."height"'),
        );
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

        await service.getPoolSummary();
        await service.getPoolSummary();

        expect(repository.query).toHaveBeenCalledTimes(1);
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
