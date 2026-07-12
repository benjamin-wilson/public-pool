import { DataSource, EntityManager } from 'typeorm';

import type { PayoutDistributionEntry } from './payout-distribution';
import { PayoutSnapshotService } from './payout-snapshot.service';

const ADDRESS_A = 'bc1qs29kyaqqc0fkvj897ke9e5xa9utljjey0y5jjn';
const ADDRESS_B = 'bc1q99n3pu025yyu0jlywpmwzalyhm36tg5u37w20d';

describe('PayoutSnapshotService', () => {
    let originalEnv: NodeJS.ProcessEnv;
    let manager: { query: jest.Mock };
    let dataSource: { transaction: jest.Mock; query: jest.Mock };
    let service: PayoutSnapshotService;

    beforeEach(() => {
        originalEnv = { ...process.env };
        process.env.PAYOUT_SNAPSHOT_ENABLED = 'true';
        process.env.PAYOUT_METHOD = 'pplns';
        process.env.PAYOUT_WINDOW_FACTOR = '4';
        process.env.PAYOUT_BOOTSTRAP_WINDOW = 'false';
        process.env.PAYOUT_MAX_COINBASE_OUTPUTS = '10';
        process.env.PAYOUT_MIN_OUTPUT_SATS = '546';
        process.env.PAYOUT_FEE_PERCENT = '0';
        process.env.PAYOUT_FEE_ADDRESS = '';
        process.env.PAYOUT_COINBASE_WEIGHT_BUDGET = '50000';
        manager = { query: jest.fn() };
        dataSource = {
            transaction: jest.fn(async callback => callback(manager as unknown as EntityManager)),
            query: jest.fn(),
        };
        service = new PayoutSnapshotService(dataSource as unknown as DataSource);
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it('should create a PPLNS payout snapshot from finalized rollup batches', async () => {
        manager.query
            .mockResolvedValueOnce([{
                startBatchId: '10',
                endBatchId: '12',
                windowStartShareIndex: '1000',
                windowEndShareIndex: '2000',
                totalCreditedDifficulty: '100',
                totalAcceptedShareCount: '5',
            }])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                { address: ADDRESS_A, creditedDifficulty: 60, acceptedShareCount: 3 },
                { address: ADDRESS_B, creditedDifficulty: 40, acceptedShareCount: 2 },
            ])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ id: '55' }])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{
                id: '55',
                method: 'pplns',
                blockHeight: 900000,
                coinbaseValueSats: '1000',
                windowStartShareIndex: '1000',
                windowEndShareIndex: '2000',
                totalCreditedDifficulty: 100,
                totalAcceptedShareCount: '5',
                eligibleAddressCount: 2,
                includedOutputCount: 2,
                distributedSats: '1000',
                unallocatedRemainderSats: '0',
            }])
            .mockResolvedValueOnce([
                { address: ADDRESS_A, payoutSats: '600' },
                { address: ADDRESS_B, payoutSats: '400' },
            ]);

        const snapshot = await service.createSnapshotForTemplate({
            blockHeight: 900000,
            coinbaseValueSats: 1000,
            networkDifficulty: 25,
        });

        expect(snapshot).toEqual(expect.objectContaining({
            id: '55',
            method: 'pplns',
            blockHeight: 900000,
            totalCreditedDifficulty: 100,
            totalAcceptedShareCount: 5,
            distributedSats: '1000',
            unallocatedRemainderSats: '0',
        }));
        expect(snapshot.payoutOutputs).toEqual([
            { address: ADDRESS_A, amountSats: 600, percent: 60 },
            { address: ADDRESS_B, amountSats: 400, percent: 40 },
        ]);
        expect(manager.query).toHaveBeenCalledTimes(8);
        expect(manager.query.mock.calls[0][1]).toEqual([100, 'pplns']);

        const entryInsertCalls = manager.query.mock.calls.filter(([sql]) => (
            sql.includes('INSERT INTO "payout_snapshot_entry"')
        ));
        expect(entryInsertCalls).toHaveLength(1);
        expect(entryInsertCalls[0][0]).toContain('FROM UNNEST(');
        expect(entryInsertCalls[0][0]).toContain('WITH ORDINALITY');
        expect(entryInsertCalls[0][0]).toContain('ORDER BY entry."ordinality"');
        expect(entryInsertCalls[0][1]).toEqual([
            '55',
            'pplns',
            [ADDRESS_A, ADDRESS_B],
            [60, 40],
            [3, 2],
            [0.6, 0.4],
            [600, 400],
            [600, 400],
            [0, 0],
            [0, 0],
            [true, true],
            ['coinbase', 'coinbase'],
            [1, 2],
        ]);
    });

    it('should bound and chunk set-based snapshot entry inserts without changing values', async () => {
        const entries: PayoutDistributionEntry[] = Array.from({ length: 1_001 }, (_, index) => {
            const includedInCoinbase = index % 3 !== 0;
            const balanceBeforeSats = 200 + index;
            const grossPayoutSats = 10_000 + index;
            return {
                address: `test-address-${index}`,
                creditedDifficulty: index + 0.5,
                acceptedShareCount: index + 1,
                payoutWeight: (index + 1) / 1_001,
                grossPayoutSats,
                payoutSats: includedInCoinbase ? 1_000 + index : 0,
                balanceBeforeSats,
                balanceAfterSats: includedInCoinbase
                    ? balanceBeforeSats
                    : balanceBeforeSats + grossPayoutSats,
                includedInCoinbase,
                rank: 1_001 - index,
            };
        });
        const insertSnapshotEntries = Reflect.get(service, 'insertSnapshotEntries') as (
            manager: EntityManager,
            snapshotId: string,
            entries: PayoutDistributionEntry[],
        ) => Promise<void>;
        let resolveFirstInsert: () => void = () => {
            throw new Error('First insert did not start');
        };
        manager.query
            .mockImplementationOnce(() => new Promise<void>(resolve => {
                resolveFirstInsert = () => resolve();
            }))
            .mockResolvedValueOnce([]);

        const insertion = insertSnapshotEntries.call(
            service,
            manager as unknown as EntityManager,
            '77',
            entries,
        );

        expect(manager.query).toHaveBeenCalledTimes(1);
        resolveFirstInsert();
        await insertion;
        expect(manager.query).toHaveBeenCalledTimes(2);
        const calls = manager.query.mock.calls;
        expect(calls.map(([, parameters]) => parameters.length)).toEqual([13, 13]);
        expect(calls.map(([, parameters]) => parameters[2].length)).toEqual([1_000, 1]);
        for (const [sql, parameters] of calls) {
            expect(sql).toContain('FROM UNNEST(');
            expect(sql).toContain('ORDER BY entry."ordinality"');
            for (const values of parameters.slice(2)) {
                expect(values.length).toBeLessThanOrEqual(1_000);
            }
        }

        const expectedParameters = (batch: PayoutDistributionEntry[]) => [
            '77',
            'pplns',
            batch.map(entry => entry.address),
            batch.map(entry => entry.creditedDifficulty),
            batch.map(entry => entry.acceptedShareCount),
            batch.map(entry => entry.payoutWeight),
            batch.map(entry => entry.grossPayoutSats),
            batch.map(entry => entry.payoutSats),
            batch.map(entry => entry.balanceBeforeSats),
            batch.map(entry => entry.balanceAfterSats),
            batch.map(entry => entry.includedInCoinbase),
            batch.map(entry => entry.includedInCoinbase ? 'coinbase' : 'pending'),
            batch.map(entry => entry.rank),
        ];
        expect(calls[0][1]).toEqual(expectedParameters(entries.slice(0, 1_000)));
        expect(calls[1][1]).toEqual(expectedParameters(entries.slice(1_000)));
    });

    it('should bootstrap the PPLNS window from paid block count up to the configured factor', async () => {
        process.env.PAYOUT_BOOTSTRAP_WINDOW = 'true';
        service = new PayoutSnapshotService(dataSource as unknown as DataSource);
        manager.query
            .mockResolvedValueOnce([{ paidBlockCount: 1 }])
            .mockResolvedValueOnce([{
                startBatchId: '10',
                endBatchId: '12',
                windowStartShareIndex: '1000',
                windowEndShareIndex: '2000',
                totalCreditedDifficulty: '50',
                totalAcceptedShareCount: '3',
            }])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                { address: ADDRESS_A, creditedDifficulty: 30, acceptedShareCount: 2 },
                { address: ADDRESS_B, creditedDifficulty: 20, acceptedShareCount: 1 },
            ])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ id: '56' }])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{
                id: '56',
                method: 'pplns',
                blockHeight: 900001,
                coinbaseValueSats: '1000',
                windowStartShareIndex: '1000',
                windowEndShareIndex: '2000',
                totalCreditedDifficulty: 50,
                totalAcceptedShareCount: '3',
                eligibleAddressCount: 2,
                includedOutputCount: 2,
                distributedSats: '1000',
                unallocatedRemainderSats: '0',
            }])
            .mockResolvedValueOnce([
                { address: ADDRESS_A, payoutSats: '600' },
                { address: ADDRESS_B, payoutSats: '400' },
            ]);

        await expect(service.createSnapshotForTemplate({
            blockHeight: 900001,
            coinbaseValueSats: 1000,
            networkDifficulty: 25,
        })).resolves.toEqual(expect.objectContaining({
            id: '56',
            totalCreditedDifficulty: 50,
        }));

        expect(manager.query.mock.calls[0][0]).toContain('COUNT(DISTINCT "blockHeight")');
        expect(manager.query.mock.calls[1][1]).toEqual([50, 'pplns']);
        expect(manager.query.mock.calls[5][1][5]).toBe(50);
        expect(manager.query.mock.calls[5][1][6]).toBe(2);
    });

    it('should not create a snapshot when there is no finalized rollup work', async () => {
        manager.query.mockResolvedValueOnce([{
            startBatchId: null,
            endBatchId: null,
            windowStartShareIndex: null,
            windowEndShareIndex: null,
            totalCreditedDifficulty: '0',
            totalAcceptedShareCount: '0',
        }]);

        await expect(service.createSnapshotForTemplate({
            blockHeight: 900000,
            coinbaseValueSats: 1000,
            networkDifficulty: 25,
        })).resolves.toBeNull();
        expect(manager.query).toHaveBeenCalledTimes(1);
    });

    it('should reuse an existing snapshot for the same template and rollup window', async () => {
        manager.query
            .mockResolvedValueOnce([{
                startBatchId: '10',
                endBatchId: '12',
                windowStartShareIndex: '1000',
                windowEndShareIndex: '2000',
                totalCreditedDifficulty: '100',
                totalAcceptedShareCount: '5',
            }])
            .mockResolvedValueOnce([{ id: '55' }])
            .mockResolvedValueOnce([{
                id: '55',
                method: 'pplns',
                blockHeight: 900000,
                coinbaseValueSats: '1000',
                windowStartShareIndex: '1000',
                windowEndShareIndex: '2000',
                totalCreditedDifficulty: 100,
                totalAcceptedShareCount: '5',
                eligibleAddressCount: 2,
                includedOutputCount: 2,
                distributedSats: '1000',
                unallocatedRemainderSats: '0',
            }])
            .mockResolvedValueOnce([
                { address: ADDRESS_A, payoutSats: '600' },
                { address: ADDRESS_B, payoutSats: '400' },
            ]);

        const snapshot = await service.createSnapshotForTemplate({
            blockHeight: 900000,
            coinbaseValueSats: 1000,
            networkDifficulty: 25,
        });

        expect(snapshot.id).toBe('55');
        expect(snapshot.payoutOutputs).toEqual([
            { address: ADDRESS_A, amountSats: 600, percent: 60 },
            { address: ADDRESS_B, amountSats: 400, percent: 40 },
        ]);
        expect(manager.query).toHaveBeenCalledTimes(4);
    });

    it('stores bridge seeds with a non-active status excluded from latest payout queries', async () => {
        manager.query
            .mockResolvedValueOnce([{
                startBatchId: '10',
                endBatchId: '12',
                windowStartShareIndex: '1000',
                windowEndShareIndex: '2000',
                totalCreditedDifficulty: '100',
                totalAcceptedShareCount: '5',
            }])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                { address: ADDRESS_A, creditedDifficulty: 100, acceptedShareCount: 5 },
            ])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ id: 'seed-57' }])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{
                id: 'seed-57',
                method: 'pplns',
                payoutMode: 'pplns',
                blockHeight: 900002,
                coinbaseValueSats: '1000',
                windowStartShareIndex: '1000',
                windowEndShareIndex: '2000',
                totalCreditedDifficulty: 100,
                totalAcceptedShareCount: '5',
                eligibleAddressCount: 1,
                includedOutputCount: 1,
                distributedSats: '1000',
                unallocatedRemainderSats: '0',
            }])
            .mockResolvedValueOnce([{ address: ADDRESS_A, payoutSats: '1000' }]);

        await expect(service.createSnapshotForTemplate({
            blockHeight: 900002,
            coinbaseValueSats: 1000,
            networkDifficulty: 25,
            visibility: 'bridge_seed',
        })).resolves.toEqual(expect.objectContaining({ id: 'seed-57' }));

        const existingLookupSql = manager.query.mock.calls[1][0] as string;
        const insertSql = manager.query.mock.calls[4][0] as string;
        expect(existingLookupSql).toContain(`"status" = 'bridge_seed'`);
        expect(insertSql).toContain(`'bridge_seed'`);
        dataSource.query.mockResolvedValueOnce([]);
        await expect(service.getLatestSnapshot()).resolves.toBeNull();
        expect(dataSource.query.mock.calls[0][0]).toContain(`"status" = 'finalized'`);
    });

    it('should finalize snapshot balances and payout history for a found block', async () => {
        manager.query
            .mockResolvedValueOnce([{ id: '55', coinbaseValueSats: '1000' }])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                {
                    address: ADDRESS_A,
                    payoutSats: '600',
                    balanceBeforeSats: '0',
                    balanceAfterSats: '0',
                    creditedDifficulty: 60,
                    includedInCoinbase: true,
                    rowType: 'coinbase',
                },
                {
                    address: ADDRESS_B,
                    payoutSats: '400',
                    balanceBeforeSats: '0',
                    balanceAfterSats: '0',
                    creditedDifficulty: 40,
                    includedInCoinbase: true,
                    rowType: 'coinbase',
                },
            ])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);

        await expect(service.finalizeSnapshotForBlock({
            payoutSnapshotId: '55',
            blockHeight: 900000,
            blockSubmissionResult: 'SUCCESS!',
        })).resolves.toEqual({
            finalized: true,
            payoutSnapshotId: '55',
            historyRows: 2,
            balanceRows: 2,
        });
        expect(manager.query).toHaveBeenCalledTimes(7);
    });

    it('should skip finalization when a block was already processed', async () => {
        manager.query
            .mockResolvedValueOnce([{ id: '55', coinbaseValueSats: '1000' }])
            .mockResolvedValueOnce([{ id: '99' }]);

        await expect(service.finalizeSnapshotForBlock({
            payoutSnapshotId: '55',
            blockHeight: 900000,
            blockSubmissionResult: 'SUCCESS!',
        })).resolves.toEqual({
            finalized: false,
            reason: 'already-finalized',
            payoutSnapshotId: '55',
        });
        expect(manager.query).toHaveBeenCalledTimes(2);
    });

    it('should return the latest current expected PPLNS payout for an address', async () => {
        dataSource.query.mockResolvedValueOnce([{
            snapshotId: '55',
            blockHeight: 900000,
            coinbaseValueSats: '1000',
            distributedSats: '1000',
            totalCreditedDifficulty: '100',
            includedOutputCount: 2,
            createdAt: new Date('2026-06-16T12:00:00.000Z'),
            payoutMode: 'pplns',
            payoutSats: '600',
            grossPayoutSats: '600',
            creditedDifficulty: '60',
            payoutWeight: '0.6',
        }]);

        await expect(service.getLatestExpectedPayoutForAddress(ADDRESS_A)).resolves.toEqual({
            snapshotId: '55',
            blockHeight: 900000,
            payoutMode: 'pplns',
            payoutSats: 600,
            grossPayoutSats: 600,
            creditedDifficulty: 60,
            payoutWeight: 0.6,
            coinbaseValueSats: 1000,
            distributedSats: 1000,
            totalCreditedDifficulty: 100,
            includedOutputCount: 2,
            createdAt: new Date('2026-06-16T12:00:00.000Z'),
            percent: 60,
        });
        expect(dataSource.query.mock.calls[0][1]).toEqual([ADDRESS_A, 'pplns']);
        expect(dataSource.query.mock.calls[0][0]).toContain('WITH latest_snapshot AS');
    });

    it('should return null when the latest PPLNS snapshot does not pay the address', async () => {
        dataSource.query.mockResolvedValueOnce([]);

        await expect(service.getLatestExpectedPayoutForAddress(ADDRESS_A)).resolves.toBeNull();
    });
});
