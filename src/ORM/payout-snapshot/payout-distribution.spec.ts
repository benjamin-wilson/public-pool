import { buildPayoutDistribution } from './payout-distribution';

const ADDRESS_A = 'bc1qs29kyaqqc0fkvj897ke9e5xa9utljjey0y5jjn';
const ADDRESS_B = 'bc1q99n3pu025yyu0jlywpmwzalyhm36tg5u37w20d';
const ADDRESS_C = 'bc1q7yx4d3xspf4xvssmsm4prf4mg2slkv8jtkc5l6';

describe('buildPayoutDistribution', () => {
    it('should conserve the full coinbase reward across outputs', () => {
        const result = buildPayoutDistribution({
            addressWork: [
                { address: ADDRESS_A, creditedDifficulty: 2, acceptedShareCount: 2 },
                { address: ADDRESS_B, creditedDifficulty: 1, acceptedShareCount: 1 },
            ],
            balances: [],
            coinbaseValueSats: 1000,
            feePercent: 0,
            minOutputSats: 546,
            coinbaseWeightBudget: 50_000,
        });

        expect(result.payoutOutputs.map(entry => ({
            address: entry.address,
            payoutSats: entry.payoutSats,
            balanceAfterSats: entry.balanceAfterSats,
        }))).toEqual([
            { address: ADDRESS_A, payoutSats: 1000, balanceAfterSats: -334 },
        ]);
        expect(result.entries.find(entry => entry.address === ADDRESS_B))
            .toEqual(expect.objectContaining({ includedInCoinbase: false, balanceAfterSats: 333 }));
        expect(result.distributedSats).toBe(1000);
        expect(result.unallocatedRemainderSats).toBe(0);
    });

    it('should carry sub-dust work forward as signed credit', () => {
        const result = buildPayoutDistribution({
            addressWork: [
                { address: ADDRESS_A, creditedDifficulty: 999, acceptedShareCount: 999 },
                { address: ADDRESS_B, creditedDifficulty: 1, acceptedShareCount: 1 },
            ],
            balances: [],
            coinbaseValueSats: 1000,
            feePercent: 0,
            minOutputSats: 546,
            coinbaseWeightBudget: 50_000,
        });

        const pending = result.entries.find(entry => entry.address === ADDRESS_B);
        const paid = result.entries.find(entry => entry.address === ADDRESS_A);

        expect(pending).toEqual(expect.objectContaining({
            includedInCoinbase: false,
            grossPayoutSats: 1,
            payoutSats: 0,
            balanceAfterSats: 1,
        }));
        expect(paid).toEqual(expect.objectContaining({
            includedInCoinbase: true,
            payoutSats: 1000,
            balanceAfterSats: -1,
        }));
        expect(result.distributedSats).toBe(1000);
    });

    it('should trim outputs that do not fit the coinbase weight budget', () => {
        const result = buildPayoutDistribution({
            addressWork: [
                { address: ADDRESS_A, creditedDifficulty: 10, acceptedShareCount: 1 },
                { address: ADDRESS_B, creditedDifficulty: 9, acceptedShareCount: 1 },
                { address: ADDRESS_C, creditedDifficulty: 8, acceptedShareCount: 1 },
            ],
            balances: [],
            coinbaseValueSats: 3000,
            feePercent: 0,
            minOutputSats: 546,
            coinbaseWeightBudget: 850,
        });

        expect(result.payoutOutputs).toHaveLength(1);
        expect(result.payoutOutputs[0].address).toBe(ADDRESS_A);
        expect(result.entries.find(entry => entry.address === ADDRESS_B))
            .toEqual(expect.objectContaining({ includedInCoinbase: false, balanceAfterSats: 1000 }));
        expect(result.entries.find(entry => entry.address === ADDRESS_C))
            .toEqual(expect.objectContaining({ includedInCoinbase: false, balanceAfterSats: 888 }));
    });

    it('should apply positive and negative carried balances to the next distribution', () => {
        const result = buildPayoutDistribution({
            addressWork: [
                { address: ADDRESS_A, creditedDifficulty: 10, acceptedShareCount: 1 },
                { address: ADDRESS_B, creditedDifficulty: 10, acceptedShareCount: 1 },
            ],
            balances: [
                { address: ADDRESS_A, balanceSats: 100 },
                { address: ADDRESS_B, balanceSats: -100 },
            ],
            coinbaseValueSats: 2000,
            feePercent: 0,
            minOutputSats: 546,
            coinbaseWeightBudget: 50_000,
        });

        expect(result.payoutOutputs.map(entry => ({
            address: entry.address,
            payoutSats: entry.payoutSats,
            balanceAfterSats: entry.balanceAfterSats,
        }))).toEqual([
            { address: ADDRESS_A, payoutSats: 1100, balanceAfterSats: 0 },
            { address: ADDRESS_B, payoutSats: 900, balanceAfterSats: 0 },
        ]);
        expect(result.unallocatedRemainderSats).toBe(0);
    });

    it('should reserve a configured fee output before miner distribution', () => {
        const result = buildPayoutDistribution({
            addressWork: [
                { address: ADDRESS_A, creditedDifficulty: 1, acceptedShareCount: 1 },
            ],
            balances: [],
            coinbaseValueSats: 100000,
            feeAddress: ADDRESS_C,
            feePercent: 2,
            minOutputSats: 546,
            coinbaseWeightBudget: 50_000,
        });

        expect(result.payoutOutputs[0]).toEqual(expect.objectContaining({
            address: ADDRESS_C,
            payoutSats: 2000,
        }));
        expect(result.payoutOutputs[1]).toEqual(expect.objectContaining({
            address: ADDRESS_A,
            payoutSats: 98000,
        }));
    });
});
