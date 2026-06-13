import { AddressType, getAddressInfo } from 'bitcoin-address-validation';

export interface PayoutAddressWork {
    address: string;
    creditedDifficulty: number;
    acceptedShareCount: number;
}

export interface PayoutBalanceInput {
    address: string;
    balanceSats: number;
}

export interface PayoutDistributionEntry {
    address: string;
    creditedDifficulty: number;
    acceptedShareCount: number;
    payoutWeight: number;
    grossPayoutSats: number;
    payoutSats: number;
    balanceBeforeSats: number;
    balanceAfterSats: number;
    includedInCoinbase: boolean;
    rank: number;
}

export interface PayoutDistributionResult {
    entries: PayoutDistributionEntry[];
    payoutOutputs: PayoutDistributionEntry[];
    consideredAddressCount: number;
    distributedSats: number;
    unallocatedRemainderSats: number;
    feeSats: number;
}

export interface PayoutDistributionInput {
    addressWork: PayoutAddressWork[];
    balances: PayoutBalanceInput[];
    coinbaseValueSats: number;
    feeAddress?: string;
    feePercent: number;
    minOutputSats: number;
    coinbaseWeightBudget: number;
}

const DEFAULT_COINBASE_WEIGHT_BUDGET = 50_000;
const DUST_LIMIT_SATS = 546;
const COINBASE_BASE_WEIGHT = 328;
const COINBASE_WITNESS_COMMITMENT_WEIGHT = 188;
const COINBASE_OUTPUT_WEIGHT = 172;
const BUDGET_SAFETY_MARGIN_WEIGHT = 200;

const OUTPUT_WEIGHT_BY_TYPE: Record<string, number> = {
    [AddressType.p2wpkh]: 124,
    [AddressType.p2sh]: 128,
    [AddressType.p2pkh]: 136,
    [AddressType.p2wsh]: 172,
    [AddressType.p2tr]: 172,
};

const outputWeightCache = new Map<string, number>();

interface ComputedAddress {
    address: string;
    creditedDifficulty: number;
    acceptedShareCount: number;
    payoutWeight: number;
    rawFairSats: number;
    balanceBeforeSats: number;
    targetSats: number;
    payoutSats: number;
    balanceAfterSats: number;
    includedInCoinbase: boolean;
}

export function buildPayoutDistribution(input: PayoutDistributionInput): PayoutDistributionResult {
    const coinbaseValueSats = Math.max(0, Math.floor(input.coinbaseValueSats));
    const minOutputSats = Math.max(DUST_LIMIT_SATS, Math.floor(input.minOutputSats));
    const coinbaseWeightBudget = input.coinbaseWeightBudget > 0
        ? input.coinbaseWeightBudget
        : DEFAULT_COINBASE_WEIGHT_BUDGET;
    const feePercent = Number.isFinite(input.feePercent) && input.feePercent > 0
        ? input.feePercent
        : 0;
    const feeAddress = input.feeAddress?.trim() ?? '';
    const wantedFeeSats = Math.floor((feePercent / 100) * coinbaseValueSats);
    const feeSats = feeAddress.length > 0 && wantedFeeSats >= minOutputSats ? wantedFeeSats : 0;
    const minerRewardSats = coinbaseValueSats - feeSats;

    const workByAddress = new Map<string, { creditedDifficulty: number; acceptedShareCount: number }>();
    for (const work of input.addressWork) {
        if (!work.address || !Number.isFinite(work.creditedDifficulty) || work.creditedDifficulty <= 0) {
            continue;
        }
        const existing = workByAddress.get(work.address) ?? { creditedDifficulty: 0, acceptedShareCount: 0 };
        existing.creditedDifficulty += work.creditedDifficulty;
        existing.acceptedShareCount += work.acceptedShareCount;
        workByAddress.set(work.address, existing);
    }

    const balanceByAddress = new Map<string, number>();
    for (const balance of input.balances) {
        if (balance.address && Number.isFinite(balance.balanceSats) && balance.balanceSats !== 0) {
            balanceByAddress.set(balance.address, Math.trunc(balance.balanceSats));
        }
    }

    let totalCreditedDifficulty = 0;
    for (const work of workByAddress.values()) {
        totalCreditedDifficulty += work.creditedDifficulty;
    }
    if (coinbaseValueSats <= 0 || totalCreditedDifficulty <= 0) {
        return {
            entries: [],
            payoutOutputs: [],
            consideredAddressCount: 0,
            distributedSats: 0,
            unallocatedRemainderSats: coinbaseValueSats,
            feeSats,
        };
    }

    const computations = new Map<string, ComputedAddress>();
    const considered = new Set<string>([...workByAddress.keys(), ...balanceByAddress.keys()]);

    for (const address of considered) {
        const work = workByAddress.get(address);
        const creditedDifficulty = work?.creditedDifficulty ?? 0;
        const acceptedShareCount = work?.acceptedShareCount ?? 0;
        const payoutWeight = creditedDifficulty > 0 ? creditedDifficulty / totalCreditedDifficulty : 0;
        const rawFairSats = Math.floor(payoutWeight * minerRewardSats);
        const balanceBeforeSats = balanceByAddress.get(address) ?? 0;
        const targetSats = rawFairSats + balanceBeforeSats;
        computations.set(address, {
            address,
            creditedDifficulty,
            acceptedShareCount,
            payoutWeight,
            rawFairSats,
            balanceBeforeSats,
            targetSats,
            payoutSats: 0,
            balanceAfterSats: targetSats,
            includedInCoinbase: false,
        });
    }

    const feeWeight = feeSats > 0 ? outputWeightForAddress(feeAddress) : 0;
    let usedWeight = COINBASE_BASE_WEIGHT + COINBASE_WITNESS_COMMITMENT_WEIGHT + feeWeight;
    const effectiveBudget = coinbaseWeightBudget - BUDGET_SAFETY_MARGIN_WEIGHT;
    const eligible = [...computations.values()]
        .filter(row => row.targetSats >= minOutputSats)
        .sort((a, b) => b.targetSats - a.targetSats || a.address.localeCompare(b.address));

    for (const row of eligible) {
        const outputWeight = outputWeightForAddress(row.address);
        if (usedWeight + outputWeight > effectiveBudget) {
            continue;
        }
        row.includedInCoinbase = true;
        row.payoutSats = row.targetSats;
        row.balanceAfterSats = 0;
        usedWeight += outputWeight;
    }

    let distributedToMiners = 0;
    for (const row of computations.values()) {
        distributedToMiners += row.payoutSats;
    }

    const remainder = minerRewardSats - distributedToMiners;
    if (remainder > 0) {
        const keptActive = [...computations.values()]
            .filter(row => row.includedInCoinbase && row.creditedDifficulty > 0)
            .sort((a, b) => b.creditedDifficulty - a.creditedDifficulty || a.address.localeCompare(b.address));
        if (keptActive.length > 0) {
            let assigned = 0;
            for (const row of keptActive) {
                const bonus = Math.floor((remainder * row.creditedDifficulty) / totalCreditedDifficulty);
                row.payoutSats += bonus;
                row.balanceAfterSats -= bonus;
                assigned += bonus;
            }
            const residual = remainder - assigned;
            if (residual > 0) {
                keptActive[0].payoutSats += residual;
                keptActive[0].balanceAfterSats -= residual;
            }
        }
    }

    const feeEntry = feeSats > 0
        ? {
            address: feeAddress,
            creditedDifficulty: 0,
            acceptedShareCount: 0,
            payoutWeight: 0,
            grossPayoutSats: feeSats,
            payoutSats: feeSats,
            balanceBeforeSats: 0,
            balanceAfterSats: 0,
            includedInCoinbase: true,
            rank: 1,
        }
        : null;

    const minerEntries = [...computations.values()]
        .filter(row => row.includedInCoinbase || row.balanceBeforeSats !== row.balanceAfterSats || row.balanceAfterSats !== 0)
        .sort((a, b) => {
            if (a.includedInCoinbase !== b.includedInCoinbase) {
                return a.includedInCoinbase ? -1 : 1;
            }
            return b.payoutSats - a.payoutSats || b.targetSats - a.targetSats || a.address.localeCompare(b.address);
        })
        .map(row => ({
            address: row.address,
            creditedDifficulty: row.creditedDifficulty,
            acceptedShareCount: row.acceptedShareCount,
            payoutWeight: row.payoutWeight,
            grossPayoutSats: row.rawFairSats,
            payoutSats: row.payoutSats,
            balanceBeforeSats: row.balanceBeforeSats,
            balanceAfterSats: row.balanceAfterSats,
            includedInCoinbase: row.includedInCoinbase,
            rank: 0,
        }));

    const mergedEntries = feeEntry == null
        ? minerEntries
        : mergeFeeEntry(feeEntry, minerEntries);
    const entries = mergedEntries
        .map((entry, index) => ({ ...entry, rank: index + 1 }));
    const payoutOutputs = entries.filter(entry => entry.includedInCoinbase);
    const distributedSats = payoutOutputs.reduce((sum, entry) => sum + entry.payoutSats, 0);

    return {
        entries,
        payoutOutputs,
        consideredAddressCount: considered.size,
        distributedSats,
        unallocatedRemainderSats: coinbaseValueSats - distributedSats,
        feeSats,
    };
}

function mergeFeeEntry(
    feeEntry: PayoutDistributionEntry,
    minerEntries: Omit<PayoutDistributionEntry, 'rank'>[],
): Omit<PayoutDistributionEntry, 'rank'>[] {
    const existing = minerEntries.find(entry => entry.address === feeEntry.address && entry.includedInCoinbase);
    if (existing == null) {
        return [feeEntry, ...minerEntries];
    }
    existing.payoutSats += feeEntry.payoutSats;
    existing.grossPayoutSats += feeEntry.grossPayoutSats;
    return minerEntries;
}

export function outputWeightForAddress(address: string): number {
    if (!address) {
        return COINBASE_OUTPUT_WEIGHT;
    }
    const cached = outputWeightCache.get(address);
    if (cached != null) {
        return cached;
    }
    let weight = COINBASE_OUTPUT_WEIGHT;
    try {
        const info = getAddressInfo(address);
        weight = OUTPUT_WEIGHT_BY_TYPE[info.type] ?? COINBASE_OUTPUT_WEIGHT;
    } catch {
        weight = COINBASE_OUTPUT_WEIGHT;
    }
    outputWeightCache.set(address, weight);
    return weight;
}
