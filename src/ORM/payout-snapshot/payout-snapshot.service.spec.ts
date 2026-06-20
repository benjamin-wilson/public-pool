import { DataSource, EntityManager } from 'typeorm';

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
        expect(manager.query).toHaveBeenCalledTimes(9);
        expect(manager.query.mock.calls[0][1]).toEqual([100, 'pplns']);
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
