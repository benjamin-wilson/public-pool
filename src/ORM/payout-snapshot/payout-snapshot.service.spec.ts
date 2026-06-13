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
                includedOutputCount: 1,
                distributedSats: '1000',
                unallocatedRemainderSats: '0',
            }])
            .mockResolvedValueOnce([
                { address: ADDRESS_A, payoutSats: '1000' },
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
            { address: ADDRESS_A, amountSats: 1000, percent: 100 },
        ]);
        expect(manager.query).toHaveBeenCalledTimes(9);
        expect(manager.query.mock.calls[0][1]).toEqual([100]);
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
                includedOutputCount: 1,
                distributedSats: '1000',
                unallocatedRemainderSats: '0',
            }])
            .mockResolvedValueOnce([
                { address: ADDRESS_A, payoutSats: '1000' },
            ]);

        const snapshot = await service.createSnapshotForTemplate({
            blockHeight: 900000,
            coinbaseValueSats: 1000,
            networkDifficulty: 25,
        });

        expect(snapshot.id).toBe('55');
        expect(snapshot.payoutOutputs).toEqual([
            { address: ADDRESS_A, amountSats: 1000, percent: 100 },
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
                    payoutSats: '1000',
                    balanceBeforeSats: '0',
                    balanceAfterSats: '-400',
                    creditedDifficulty: 60,
                    includedInCoinbase: true,
                    rowType: 'coinbase',
                },
                {
                    address: ADDRESS_B,
                    payoutSats: '0',
                    balanceBeforeSats: '0',
                    balanceAfterSats: '400',
                    creditedDifficulty: 40,
                    includedInCoinbase: false,
                    rowType: 'pending',
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
});
