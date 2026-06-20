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

interface AllocationTarget<T> {
    item: T;
    weight: number;
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

    const fairShareSats = allocateIntegerSats(
        [...workByAddress.entries()].map(([address, work]) => ({
            item: address,
            weight: work.creditedDifficulty,
        })),
        minerRewardSats,
        totalCreditedDifficulty,
    );

    const computations = new Map<string, ComputedAddress>();
    const considered = new Set<string>([...workByAddress.keys(), ...balanceByAddress.keys()]);

    for (const address of considered) {
        const work = workByAddress.get(address);
        const creditedDifficulty = work?.creditedDifficulty ?? 0;
        const acceptedShareCount = work?.acceptedShareCount ?? 0;
        const payoutWeight = creditedDifficulty > 0 ? creditedDifficulty / totalCreditedDifficulty : 0;
        const rawFairSats = fairShareSats.get(address) ?? 0;
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
    allocatePayoutTargets(computations, minerRewardSats, totalCreditedDifficulty);

    const eligible = [...computations.values()]
        .filter(row => row.payoutSats > 0 && (row.creditedDifficulty > 0 || row.payoutSats >= minOutputSats))
        .sort((a, b) => b.payoutSats - a.payoutSats || b.targetSats - a.targetSats || a.address.localeCompare(b.address));

    for (const row of eligible) {
        const outputWeight = outputWeightForAddress(row.address);
        if (usedWeight + outputWeight > effectiveBudget) {
            row.balanceAfterSats = row.targetSats;
            continue;
        }
        row.includedInCoinbase = true;
        row.balanceAfterSats = row.targetSats - row.payoutSats;
        usedWeight += outputWeight;
    }
    for (const row of computations.values()) {
        if (!row.includedInCoinbase && row.payoutSats > 0) {
            row.payoutSats = 0;
            row.balanceAfterSats = row.targetSats;
        }
    }

    redistributeUnfitMinerPayouts(computations, minerRewardSats);

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

function allocatePayoutTargets(
    computations: Map<string, ComputedAddress>,
    minerRewardSats: number,
    totalCreditedDifficulty: number,
): void {
    const positiveTargets = [...computations.values()]
        .filter(row => row.targetSats > 0);
    const totalPositiveTarget = positiveTargets.reduce((sum, row) => sum + row.targetSats, 0);

    if (totalPositiveTarget <= 0) {
        const activeRows = [...computations.values()]
            .filter(row => row.creditedDifficulty > 0);
        const activeAllocations = allocateIntegerSats(
            activeRows.map(row => ({ item: row.address, weight: row.creditedDifficulty })),
            minerRewardSats,
            totalCreditedDifficulty,
        );
        for (const row of activeRows) {
            row.payoutSats = activeAllocations.get(row.address) ?? 0;
            row.balanceAfterSats = row.targetSats - row.payoutSats;
        }
        return;
    }

    if (totalPositiveTarget <= minerRewardSats) {
        for (const row of positiveTargets) {
            row.payoutSats = row.targetSats;
            row.balanceAfterSats = 0;
        }
        const surplus = minerRewardSats - totalPositiveTarget;
        if (surplus <= 0) {
            return;
        }
        const activeRows = positiveTargets.filter(row => row.creditedDifficulty > 0);
        const activeWeight = activeRows.reduce((sum, row) => sum + row.creditedDifficulty, 0);
        const surplusAllocations = allocateIntegerSats(
            activeRows.map(row => ({ item: row.address, weight: row.creditedDifficulty })),
            surplus,
            activeWeight,
        );
        for (const row of activeRows) {
            const extra = surplusAllocations.get(row.address) ?? 0;
            row.payoutSats += extra;
            row.balanceAfterSats -= extra;
        }
        return;
    }

    const cappedAllocations = allocateIntegerSats(
        positiveTargets.map(row => ({ item: row.address, weight: row.targetSats })),
        minerRewardSats,
        totalPositiveTarget,
    );
    for (const row of positiveTargets) {
        row.payoutSats = cappedAllocations.get(row.address) ?? 0;
        row.balanceAfterSats = row.targetSats - row.payoutSats;
    }
}

function redistributeUnfitMinerPayouts(
    computations: Map<string, ComputedAddress>,
    minerRewardSats: number,
): void {
    const distributedToMiners = [...computations.values()]
        .filter(row => row.includedInCoinbase)
        .reduce((sum, row) => sum + row.payoutSats, 0);
    const remainder = minerRewardSats - distributedToMiners;
    if (remainder <= 0) {
        return;
    }

    const keptActive = [...computations.values()]
        .filter(row => row.includedInCoinbase && row.creditedDifficulty > 0);
    const keptDifficulty = keptActive.reduce((sum, row) => sum + row.creditedDifficulty, 0);
    if (keptDifficulty <= 0) {
        return;
    }

    const bonusAllocations = allocateIntegerSats(
        keptActive.map(row => ({ item: row.address, weight: row.creditedDifficulty })),
        remainder,
        keptDifficulty,
    );
    for (const row of keptActive) {
        const bonus = bonusAllocations.get(row.address) ?? 0;
        row.payoutSats += bonus;
        row.balanceAfterSats -= bonus;
    }
}

function allocateIntegerSats<T extends string>(
    targets: AllocationTarget<T>[],
    amountSats: number,
    totalWeight: number,
): Map<T, number> {
    const result = new Map<T, number>();
    if (amountSats <= 0 || totalWeight <= 0) {
        return result;
    }

    let assigned = 0;
    const fractions = targets
        .filter(target => target.weight > 0)
        .map(target => {
            const exact = (target.weight * amountSats) / totalWeight;
            const whole = Math.floor(exact);
            assigned += whole;
            result.set(target.item, whole);
            return {
                item: target.item,
                weight: target.weight,
                fraction: exact - whole,
            };
        })
        .sort((a, b) => b.fraction - a.fraction || b.weight - a.weight || a.item.localeCompare(b.item));

    let residual = amountSats - assigned;
    for (const target of fractions) {
        if (residual <= 0) {
            break;
        }
        result.set(target.item, (result.get(target.item) ?? 0) + 1);
        residual--;
    }

    return result;
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
