import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import type { AddressObject } from '../../models/MiningJob';
import {
    buildPayoutDistribution,
    PayoutAddressWork,
    PayoutBalanceInput,
    PayoutDistributionEntry,
} from './payout-distribution';

export interface PayoutSnapshotForTemplate {
    id: string;
    method: string;
    blockHeight: number;
    coinbaseValueSats: string;
    windowStartShareIndex: string;
    windowEndShareIndex: string;
    totalCreditedDifficulty: number;
    totalAcceptedShareCount: number;
    eligibleAddressCount: number;
    includedOutputCount: number;
    distributedSats: string;
    unallocatedRemainderSats: string;
    payoutOutputs: AddressObject[];
}

export interface PayoutFinalizationResult {
    finalized: boolean;
    reason?: 'disabled' | 'missing-snapshot' | 'already-finalized' | 'duplicate';
    payoutSnapshotId?: string;
    historyRows?: number;
    balanceRows?: number;
}

const DEFAULT_MAX_COINBASE_OUTPUTS = 10;
const DEFAULT_MIN_OUTPUT_SATS = 546;
const DEFAULT_PAYOUT_METHOD = 'pplns';
const DEFAULT_PAYOUT_WINDOW_FACTOR = 4;
const DEFAULT_COINBASE_WEIGHT_BUDGET = 50_000;

@Injectable()
export class PayoutSnapshotService {
    private readonly snapshotsEnabled = this.readBoolean('PAYOUT_SNAPSHOT_ENABLED', true);
    private readonly method = process.env.PAYOUT_METHOD ?? DEFAULT_PAYOUT_METHOD;
    private readonly windowFactor = this.readPositiveNumber('PAYOUT_WINDOW_FACTOR', DEFAULT_PAYOUT_WINDOW_FACTOR);
    private readonly maxCoinbaseOutputs = this.readPositiveInt('PAYOUT_MAX_COINBASE_OUTPUTS', DEFAULT_MAX_COINBASE_OUTPUTS);
    private readonly minOutputSats = this.readNonNegativeInt('PAYOUT_MIN_OUTPUT_SATS', DEFAULT_MIN_OUTPUT_SATS);
    private readonly feeAddress = process.env.PAYOUT_FEE_ADDRESS?.trim() ?? '';
    private readonly feePercent = this.readNonNegativeNumber('PAYOUT_FEE_PERCENT', 0);
    private readonly coinbaseWeightBudget = this.readPositiveInt('PAYOUT_COINBASE_WEIGHT_BUDGET', DEFAULT_COINBASE_WEIGHT_BUDGET);

    constructor(
        private readonly dataSource: DataSource,
    ) { }

    public async createSnapshotForTemplate(input: {
        blockHeight: number;
        coinbaseValueSats: number;
        networkDifficulty: number;
    }): Promise<PayoutSnapshotForTemplate | null> {
        if (!this.snapshotsEnabled || input.coinbaseValueSats <= 0 || input.networkDifficulty <= 0) {
            return null;
        }

        return this.dataSource.transaction(async manager => {
            const windowTargetDifficulty = input.networkDifficulty * this.windowFactor;
            const window = await this.getPplnsWindow(manager, windowTargetDifficulty);
            if (window == null || this.toNumber(window.totalCreditedDifficulty) <= 0) {
                return null;
            }

            const existing = await this.getExistingSnapshot(manager, {
                blockHeight: input.blockHeight,
                coinbaseValueSats: input.coinbaseValueSats,
                windowEndShareIndex: window.windowEndShareIndex,
            });
            if (existing != null) {
                return existing;
            }

            const addressWork = await this.getAddressWork(manager, window);
            const balances = await this.getOpenBalances(manager);
            if (addressWork.length === 0) {
                return null;
            }

            const distribution = buildPayoutDistribution({
                addressWork,
                balances,
                coinbaseValueSats: input.coinbaseValueSats,
                feeAddress: this.feeAddress,
                feePercent: this.feePercent,
                minOutputSats: this.minOutputSats,
                coinbaseWeightBudget: this.coinbaseWeightBudget,
            });
            const entries = this.limitCoinbaseOutputs(distribution.entries);
            if (entries.every(entry => !entry.includedInCoinbase)) {
                return null;
            }

            const includedOutputCount = entries.filter(entry => entry.includedInCoinbase).length;
            const distributedSats = entries
                .filter(entry => entry.includedInCoinbase)
                .reduce((sum, entry) => sum + entry.payoutSats, 0);
            const unallocatedRemainderSats = input.coinbaseValueSats - distributedSats;
            const [snapshotRow] = await manager.query(`
                INSERT INTO "payout_snapshot" (
                    "method",
                    "status",
                    "blockHeight",
                    "coinbaseValueSats",
                    "networkDifficulty",
                    "windowTargetDifficulty",
                    "windowFactor",
                    "feeAddress",
                    "feeSats",
                    "minPayoutSats",
                    "coinbaseWeightBudget",
                    "startBatchId",
                    "endBatchId",
                    "windowStartShareIndex",
                    "windowEndShareIndex",
                    "totalCreditedDifficulty",
                    "totalAcceptedShareCount",
                    "eligibleAddressCount",
                    "includedOutputCount",
                    "distributedSats",
                    "unallocatedRemainderSats"
                ) VALUES (
                    $1,
                    'finalized',
                    $2::bigint,
                    $3::bigint,
                    $4::numeric,
                    $5::numeric,
                    $6::numeric,
                    NULLIF($7, ''),
                    $8::bigint,
                    $9::int,
                    $10::int,
                    $11::bigint,
                    $12::bigint,
                    $13::bigint,
                    $14::bigint,
                    $15::numeric,
                    $16::bigint,
                    $17::int,
                    $18::int,
                    $19::bigint,
                    $20::bigint
                )
                RETURNING "id"::text AS "id"
            `, [
                this.method,
                input.blockHeight,
                input.coinbaseValueSats.toString(),
                input.networkDifficulty,
                windowTargetDifficulty,
                this.windowFactor,
                this.feeAddress,
                distribution.feeSats.toString(),
                this.minOutputSats,
                this.coinbaseWeightBudget,
                window.startBatchId,
                window.endBatchId,
                window.windowStartShareIndex,
                window.windowEndShareIndex,
                window.totalCreditedDifficulty,
                window.totalAcceptedShareCount,
                distribution.consideredAddressCount,
                includedOutputCount,
                distributedSats.toString(),
                unallocatedRemainderSats.toString(),
            ]);

            for (const entry of entries) {
                await this.insertSnapshotEntry(manager, snapshotRow.id, entry);
            }

            return this.getSnapshotById(manager, snapshotRow.id);
        });
    }

    public async finalizeSnapshotForBlock(input: {
        payoutSnapshotId?: string | null;
        blockHeight: number;
        blockSubmissionResult?: string | null;
    }): Promise<PayoutFinalizationResult> {
        if (!this.snapshotsEnabled) {
            return { finalized: false, reason: 'disabled' };
        }
        if (!this.isSuccessfulBlockSubmission(input.blockSubmissionResult)) {
            return { finalized: false, reason: 'missing-snapshot' };
        }
        if (input.payoutSnapshotId == null) {
            return { finalized: false, reason: 'missing-snapshot' };
        }

        return this.dataSource.transaction<PayoutFinalizationResult>(async manager => {
            const [snapshot] = await manager.query(`
                SELECT "id"::text AS "id", "coinbaseValueSats"::text AS "coinbaseValueSats"
                FROM "payout_snapshot"
                WHERE "id" = $1::bigint
                LIMIT 1
            `, [input.payoutSnapshotId]);
            if (snapshot == null) {
                return { finalized: false, reason: 'missing-snapshot' };
            }

            const [existing] = await manager.query(`
                SELECT "id"::text AS "id"
                FROM "payout_history"
                WHERE "blockHeight" = $1::bigint
                LIMIT 1
            `, [input.blockHeight]);
            if (existing != null) {
                return {
                    finalized: false,
                    reason: 'already-finalized',
                    payoutSnapshotId: input.payoutSnapshotId,
                };
            }

            const entries = await manager.query(`
                SELECT
                    "address",
                    "payoutSats"::text AS "payoutSats",
                    "balanceBeforeSats"::text AS "balanceBeforeSats",
                    "balanceAfterSats"::text AS "balanceAfterSats",
                    "creditedDifficulty"::float AS "creditedDifficulty",
                    "includedInCoinbase",
                    "rowType"
                FROM "payout_snapshot_entry"
                WHERE "snapshotId" = $1::bigint
                ORDER BY "rank"
            `, [input.payoutSnapshotId]);
            if (entries.length === 0) {
                return { finalized: false, reason: 'missing-snapshot' };
            }

            let balanceRows = 0;
            let historyRows = 0;
            const coinbaseValue = this.toNumber(snapshot.coinbaseValueSats);
            for (const entry of entries) {
                const payoutSats = this.toNumber(entry.payoutSats);
                const balanceBeforeSats = this.toNumber(entry.balanceBeforeSats);
                const balanceAfterSats = this.toNumber(entry.balanceAfterSats);
                const isCoinbase = entry.includedInCoinbase === true;
                const wasActive = this.toNumber(entry.creditedDifficulty) > 0;

                await manager.query(`
                    INSERT INTO "payout_balance" (
                        "address",
                        "balanceSats",
                        "totalPaidSats",
                        "lastAcceptedShareAt",
                        "updatedAt"
                    ) VALUES (
                        $1,
                        $2::bigint,
                        $3::bigint,
                        CASE WHEN $4::boolean THEN NOW() ELSE NULL END,
                        NOW()
                    )
                    ON CONFLICT ("address") DO UPDATE SET
                        "balanceSats" = EXCLUDED."balanceSats",
                        "totalPaidSats" = "payout_balance"."totalPaidSats" + EXCLUDED."totalPaidSats",
                        "lastAcceptedShareAt" = CASE
                            WHEN $4::boolean THEN NOW()
                            ELSE "payout_balance"."lastAcceptedShareAt"
                        END,
                        "updatedAt" = NOW()
                `, [
                    entry.address,
                    balanceAfterSats.toString(),
                    isCoinbase ? payoutSats.toString() : '0',
                    wasActive,
                ]);
                balanceRows++;

                await manager.query(`
                    INSERT INTO "payout_history" (
                        "blockHeight",
                        "payoutSnapshotId",
                        "address",
                        "paidSats",
                        "percent",
                        "balanceBeforeSats",
                        "balanceAfterSats",
                        "rowType"
                    ) VALUES (
                        $1::bigint,
                        $2::bigint,
                        $3,
                        $4::bigint,
                        $5::numeric,
                        $6::bigint,
                        $7::bigint,
                        $8
                    )
                    ON CONFLICT ("blockHeight", "address") DO NOTHING
                `, [
                    input.blockHeight,
                    input.payoutSnapshotId,
                    entry.address,
                    payoutSats.toString(),
                    coinbaseValue > 0 && isCoinbase ? (payoutSats / coinbaseValue) * 100 : 0,
                    balanceBeforeSats.toString(),
                    balanceAfterSats.toString(),
                    isCoinbase ? 'coinbase' : 'pending',
                ]);
                historyRows++;
            }

            return {
                finalized: true,
                payoutSnapshotId: input.payoutSnapshotId,
                historyRows,
                balanceRows,
            };
        }).catch(error => {
            if (error?.code === '23505') {
                return {
                    finalized: false,
                    reason: 'duplicate',
                    payoutSnapshotId: input.payoutSnapshotId ?? undefined,
                };
            }
            throw error;
        });
    }

    public async getLatestSnapshot(): Promise<PayoutSnapshotForTemplate | null> {
        const [snapshot] = await this.dataSource.query(`
            SELECT "id"::text AS "id"
            FROM "payout_snapshot"
            WHERE "status" = 'finalized'
            ORDER BY "createdAt" DESC, "id" DESC
            LIMIT 1
        `);
        if (snapshot?.id == null) {
            return null;
        }
        return this.dataSource.transaction(manager => this.getSnapshotById(manager, snapshot.id));
    }

    private async getPplnsWindow(manager: EntityManager, windowTargetDifficulty: number): Promise<{
        startBatchId: string;
        endBatchId: string;
        windowStartShareIndex: string;
        windowEndShareIndex: string;
        totalCreditedDifficulty: string;
        totalAcceptedShareCount: string;
    } | null> {
        const [window] = await manager.query(`
            WITH ordered AS MATERIALIZED (
                SELECT
                    "id",
                    "startShareIndex",
                    "endShareIndex",
                    "acceptedShareCount",
                    "creditedDifficulty",
                    COALESCE(
                        SUM("creditedDifficulty") OVER (
                            ORDER BY "endShareIndex" DESC
                            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                        ),
                        0
                    ) AS "difficultyAfter"
                FROM "share_rollup_batch"
                WHERE "status" = 'finalized'
            ),
            selected AS MATERIALIZED (
                SELECT *
                FROM ordered
                WHERE "difficultyAfter" < $1::numeric
            )
            SELECT
                MIN("id")::text AS "startBatchId",
                MAX("id")::text AS "endBatchId",
                MIN("startShareIndex")::text AS "windowStartShareIndex",
                MAX("endShareIndex")::text AS "windowEndShareIndex",
                COALESCE(SUM("creditedDifficulty"), 0)::numeric AS "totalCreditedDifficulty",
                COALESCE(SUM("acceptedShareCount"), 0)::bigint AS "totalAcceptedShareCount"
            FROM selected
        `, [windowTargetDifficulty]);

        if (window?.startBatchId == null || window?.windowEndShareIndex == null) {
            return null;
        }
        return window;
    }

    private async getAddressWork(
        manager: EntityManager,
        window: { windowStartShareIndex: string; windowEndShareIndex: string },
    ): Promise<PayoutAddressWork[]> {
        const rows = await manager.query(`
            SELECT
                s."address",
                COALESCE(SUM(s."creditedDifficulty"), 0)::float AS "creditedDifficulty",
                COALESCE(SUM(s."acceptedShareCount"), 0)::int AS "acceptedShareCount"
            FROM "share_rollup_batch_summary" s
            JOIN "share_rollup_batch" b ON b."id" = s."batchId"
            WHERE b."status" = 'finalized'
              AND b."endShareIndex" >= $1::bigint
              AND b."endShareIndex" <= $2::bigint
            GROUP BY s."address"
            HAVING COALESCE(SUM(s."creditedDifficulty"), 0) > 0
        `, [
            window.windowStartShareIndex,
            window.windowEndShareIndex,
        ]);
        return rows.map(row => ({
            address: row.address,
            creditedDifficulty: this.toNumber(row.creditedDifficulty),
            acceptedShareCount: this.toNumber(row.acceptedShareCount),
        }));
    }

    private async getOpenBalances(manager: EntityManager): Promise<PayoutBalanceInput[]> {
        const rows = await manager.query(`
            SELECT "address", "balanceSats"::text AS "balanceSats"
            FROM "payout_balance"
            WHERE "balanceSats" != 0
        `);
        return rows.map(row => ({
            address: row.address,
            balanceSats: this.toNumber(row.balanceSats),
        }));
    }

    private async getExistingSnapshot(
        manager: EntityManager,
        input: { blockHeight: number; coinbaseValueSats: number; windowEndShareIndex: string },
    ): Promise<PayoutSnapshotForTemplate | null> {
        const [snapshot] = await manager.query(`
            SELECT "id"::text AS "id"
            FROM "payout_snapshot"
            WHERE "method" = $1
              AND "status" = 'finalized'
              AND "blockHeight" = $2::bigint
              AND "coinbaseValueSats" = $3::bigint
              AND "windowEndShareIndex" = $4::bigint
            ORDER BY "id" DESC
            LIMIT 1
        `, [
            this.method,
            input.blockHeight,
            input.coinbaseValueSats.toString(),
            input.windowEndShareIndex,
        ]);

        if (snapshot?.id == null) {
            return null;
        }
        return this.getSnapshotById(manager, snapshot.id);
    }

    private async getSnapshotById(manager: EntityManager, id: string): Promise<PayoutSnapshotForTemplate | null> {
        const [snapshot] = await manager.query(`
            SELECT
                "id"::text AS "id",
                "method",
                "blockHeight"::int AS "blockHeight",
                "coinbaseValueSats"::text AS "coinbaseValueSats",
                "windowStartShareIndex"::text AS "windowStartShareIndex",
                "windowEndShareIndex"::text AS "windowEndShareIndex",
                "totalCreditedDifficulty"::float AS "totalCreditedDifficulty",
                "totalAcceptedShareCount"::bigint AS "totalAcceptedShareCount",
                "eligibleAddressCount",
                "includedOutputCount",
                "distributedSats"::text AS "distributedSats",
                "unallocatedRemainderSats"::text AS "unallocatedRemainderSats"
            FROM "payout_snapshot"
            WHERE "id" = $1::bigint
        `, [id]);
        if (snapshot == null) {
            return null;
        }

        const entries = await manager.query(`
            SELECT
                "address",
                "payoutSats"::text AS "payoutSats"
            FROM "payout_snapshot_entry"
            WHERE "snapshotId" = $1::bigint
              AND "includedInCoinbase" = true
            ORDER BY "rank"
        `, [id]);
        const coinbaseValue = Number(snapshot.coinbaseValueSats);

        return {
            id: snapshot.id,
            method: snapshot.method,
            blockHeight: this.toNumber(snapshot.blockHeight),
            coinbaseValueSats: snapshot.coinbaseValueSats,
            windowStartShareIndex: snapshot.windowStartShareIndex,
            windowEndShareIndex: snapshot.windowEndShareIndex,
            totalCreditedDifficulty: this.toNumber(snapshot.totalCreditedDifficulty),
            totalAcceptedShareCount: this.toNumber(snapshot.totalAcceptedShareCount),
            eligibleAddressCount: this.toNumber(snapshot.eligibleAddressCount),
            includedOutputCount: this.toNumber(snapshot.includedOutputCount),
            distributedSats: snapshot.distributedSats,
            unallocatedRemainderSats: snapshot.unallocatedRemainderSats,
            payoutOutputs: entries.map(entry => ({
                address: entry.address,
                amountSats: this.toNumber(entry.payoutSats),
                percent: coinbaseValue > 0
                    ? (this.toNumber(entry.payoutSats) / coinbaseValue) * 100
                    : 0,
            })),
        };
    }

    private async insertSnapshotEntry(manager: EntityManager, snapshotId: string, entry: PayoutDistributionEntry): Promise<void> {
        await manager.query(`
            INSERT INTO "payout_snapshot_entry" (
                "snapshotId",
                "address",
                "creditedDifficulty",
                "acceptedShareCount",
                "payoutWeight",
                "grossPayoutSats",
                "payoutSats",
                "balanceBeforeSats",
                "balanceAfterSats",
                "includedInCoinbase",
                "rowType",
                "rank"
            ) VALUES (
                $1::bigint,
                $2,
                $3::numeric,
                $4::bigint,
                $5::numeric,
                $6::bigint,
                $7::bigint,
                $8::bigint,
                $9::bigint,
                $10::boolean,
                $11,
                $12::int
            )
        `, [
            snapshotId,
            entry.address,
            entry.creditedDifficulty,
            entry.acceptedShareCount,
            entry.payoutWeight,
            entry.grossPayoutSats,
            entry.payoutSats,
            entry.balanceBeforeSats,
            entry.balanceAfterSats,
            entry.includedInCoinbase,
            entry.includedInCoinbase ? 'coinbase' : 'pending',
            entry.rank,
        ]);
    }

    private limitCoinbaseOutputs(entries: PayoutDistributionEntry[]): PayoutDistributionEntry[] {
        let included = 0;
        return entries.map(entry => {
            if (!entry.includedInCoinbase) {
                return entry;
            }
            included++;
            if (included <= this.maxCoinbaseOutputs) {
                return entry;
            }
            return {
                ...entry,
                payoutSats: 0,
                balanceAfterSats: entry.balanceAfterSats + entry.payoutSats,
                includedInCoinbase: false,
            };
        });
    }

    private isSuccessfulBlockSubmission(result?: string | null): boolean {
        return result == null || result === 'SUCCESS!';
    }

    private toNumber(value: unknown): number {
        const parsed = Number(value ?? 0);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    private readPositiveInt(name: string, defaultValue: number): number {
        const value = Number(process.env[name]);
        return Number.isInteger(value) && value > 0 ? value : defaultValue;
    }

    private readNonNegativeInt(name: string, defaultValue: number): number {
        const value = Number(process.env[name]);
        return Number.isInteger(value) && value >= 0 ? value : defaultValue;
    }

    private readPositiveNumber(name: string, defaultValue: number): number {
        const value = Number(process.env[name]);
        return Number.isFinite(value) && value > 0 ? value : defaultValue;
    }

    private readNonNegativeNumber(name: string, defaultValue: number): number {
        const value = Number(process.env[name]);
        return Number.isFinite(value) && value >= 0 ? value : defaultValue;
    }

    private readBoolean(name: string, defaultValue: boolean): boolean {
        const value = process.env[name]?.toLowerCase();
        if (value == null || value.length === 0) {
            return defaultValue;
        }
        return value === 'true' || value === '1' || value === 'yes';
    }
}
