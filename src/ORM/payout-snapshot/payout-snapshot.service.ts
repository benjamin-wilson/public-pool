import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import type { AddressObject } from '../../models/MiningJob';
import { PayoutMode } from '../../types/payout-mode';
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
    payoutMode: PayoutMode;
}

export interface PayoutFinalizationResult {
    finalized: boolean;
    reason?: 'disabled' | 'missing-snapshot' | 'already-finalized' | 'duplicate';
    payoutSnapshotId?: string;
    historyRows?: number;
    balanceRows?: number;
}

export interface ExpectedPayout {
    snapshotId: string;
    blockHeight: number;
    payoutMode: PayoutMode;
    payoutSats: number;
    grossPayoutSats: number;
    creditedDifficulty: number;
    payoutWeight: number;
    coinbaseValueSats: number;
    distributedSats: number;
    totalCreditedDifficulty: number;
    includedOutputCount: number;
    createdAt: Date;
    percent: number;
}

const DEFAULT_MAX_COINBASE_OUTPUTS = 200;
const DEFAULT_MIN_OUTPUT_SATS = 546;
const DEFAULT_PAYOUT_METHOD = 'pplns';
const DEFAULT_PAYOUT_WINDOW_FACTOR = 4;
const DEFAULT_COINBASE_WEIGHT_BUDGET = 26_000;
const DEFAULT_PAYOUT_BOOTSTRAP_WINDOW = true;
const PPLNS_PAYOUT_MODE: PayoutMode = 'pplns';
// UNNEST keeps each statement at 13 bind parameters; this cap bounds array payload size.
const PAYOUT_SNAPSHOT_ENTRY_INSERT_BATCH_SIZE = 1_000;
type PayoutSnapshotStatus = 'finalized' | 'bridge_seed';

@Injectable()
export class PayoutSnapshotService {
    private readonly snapshotsEnabled = this.readBoolean('PAYOUT_SNAPSHOT_ENABLED', true);
    private readonly method = process.env.PAYOUT_METHOD ?? DEFAULT_PAYOUT_METHOD;
    private readonly windowFactor = this.readPositiveNumber('PAYOUT_WINDOW_FACTOR', DEFAULT_PAYOUT_WINDOW_FACTOR);
    private readonly bootstrapWindow = this.readBoolean('PAYOUT_BOOTSTRAP_WINDOW', DEFAULT_PAYOUT_BOOTSTRAP_WINDOW);
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
        /** Bridge seeds are frozen/reconstructable but excluded from active payout APIs. */
        visibility?: 'active' | 'bridge_seed';
    }): Promise<PayoutSnapshotForTemplate | null> {
        if (!this.snapshotsEnabled || input.coinbaseValueSats <= 0 || input.networkDifficulty <= 0) {
            return null;
        }

        return this.dataSource.transaction(async manager => {
            const snapshotStatus: PayoutSnapshotStatus = input.visibility === 'bridge_seed'
                ? 'bridge_seed'
                : 'finalized';
            const effectiveWindowFactor = await this.getEffectiveWindowFactor(manager);
            const windowTargetDifficulty = input.networkDifficulty * effectiveWindowFactor;
            const window = await this.getPplnsWindow(manager, windowTargetDifficulty);
            if (window == null || this.toNumber(window.totalCreditedDifficulty) <= 0) {
                return null;
            }

            const existing = await this.getExistingSnapshot(manager, {
                blockHeight: input.blockHeight,
                coinbaseValueSats: input.coinbaseValueSats,
                windowEndShareIndex: window.windowEndShareIndex,
                status: snapshotStatus,
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
                    "payoutMode",
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
                    $2,
                    '${snapshotStatus}',
                    $3::bigint,
                    $4::bigint,
                    $5::numeric,
                    $6::numeric,
                    $7::numeric,
                    NULLIF($8, ''),
                    $9::bigint,
                    $10::int,
                    $11::int,
                    $12::bigint,
                    $13::bigint,
                    $14::bigint,
                    $15::bigint,
                    $16::numeric,
                    $17::bigint,
                    $18::int,
                    $19::int,
                    $20::bigint,
                    $21::bigint
                )
                RETURNING "id"::text AS "id"
            `, [
                this.method,
                PPLNS_PAYOUT_MODE,
                input.blockHeight,
                input.coinbaseValueSats.toString(),
                input.networkDifficulty,
                windowTargetDifficulty,
                effectiveWindowFactor,
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

            await this.insertSnapshotEntries(manager, snapshotRow.id, entries);

            return this.getSnapshotById(manager, snapshotRow.id);
        });
    }

    private async getEffectiveWindowFactor(manager: EntityManager): Promise<number> {
        if (!this.bootstrapWindow) {
            return this.windowFactor;
        }

        const paidBlockCount = await this.getFinalizedPayoutBlockCount(manager);
        return Math.min(this.windowFactor, Math.max(1, paidBlockCount + 1));
    }

    private async getFinalizedPayoutBlockCount(manager: EntityManager): Promise<number> {
        const [row] = await manager.query(`
            SELECT COUNT(DISTINCT "blockHeight")::int AS "paidBlockCount"
            FROM "payout_history"
            WHERE "payoutMode" = $1
        `, [PPLNS_PAYOUT_MODE]);
        return this.toNumber(row?.paidBlockCount);
    }

    public async finalizeSnapshotForBlock(input: {
        payoutSnapshotId?: string | null;
        blockHeight: number;
        blockSubmissionResult?: string | null;
        payoutMode?: PayoutMode;
    }): Promise<PayoutFinalizationResult> {
        if (!this.snapshotsEnabled) {
            return { finalized: false, reason: 'disabled' };
        }
        if ((input.payoutMode ?? PPLNS_PAYOUT_MODE) !== PPLNS_PAYOUT_MODE) {
            return { finalized: false, reason: 'missing-snapshot' };
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
                  AND "payoutMode" = $2
                LIMIT 1
            `, [input.payoutSnapshotId, PPLNS_PAYOUT_MODE]);
            if (snapshot == null) {
                return { finalized: false, reason: 'missing-snapshot' };
            }

            const [existing] = await manager.query(`
                SELECT "id"::text AS "id"
                FROM "payout_history"
                WHERE "blockHeight" = $1::bigint
                  AND "payoutMode" = $2
                LIMIT 1
            `, [input.blockHeight, PPLNS_PAYOUT_MODE]);
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
                  AND "payoutMode" = $2
                ORDER BY "rank"
            `, [input.payoutSnapshotId, PPLNS_PAYOUT_MODE]);
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
                        "payoutMode",
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
                        $4,
                        $5::bigint,
                        $6::numeric,
                        $7::bigint,
                        $8::bigint,
                        $9
                    )
                    ON CONFLICT ("payoutMode", "blockHeight", "address") DO NOTHING
                `, [
                    input.blockHeight,
                    input.payoutSnapshotId,
                    PPLNS_PAYOUT_MODE,
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
              AND "payoutMode" = $1
            ORDER BY "createdAt" DESC, "id" DESC
            LIMIT 1
        `, [PPLNS_PAYOUT_MODE]);
        if (snapshot?.id == null) {
            return null;
        }
        return this.dataSource.transaction(manager => this.getSnapshotById(manager, snapshot.id));
    }

    public async getLatestExpectedPayoutForAddress(address: string): Promise<ExpectedPayout | null> {
        const [row] = await this.dataSource.query(`
            WITH latest_snapshot AS (
                SELECT
                    "id",
                    "blockHeight",
                    "coinbaseValueSats",
                    "distributedSats",
                    "totalCreditedDifficulty",
                    "includedOutputCount",
                    "createdAt",
                    "payoutMode"
                FROM "payout_snapshot"
                WHERE "status" = 'finalized'
                  AND "payoutMode" = $2
                ORDER BY "createdAt" DESC, "id" DESC
                LIMIT 1
            )
            SELECT
                s."id"::text AS "snapshotId",
                s."blockHeight"::int AS "blockHeight",
                s."coinbaseValueSats"::text AS "coinbaseValueSats",
                s."distributedSats"::text AS "distributedSats",
                s."totalCreditedDifficulty"::text AS "totalCreditedDifficulty",
                s."includedOutputCount"::int AS "includedOutputCount",
                s."createdAt" AS "createdAt",
                e."payoutMode" AS "payoutMode",
                e."payoutSats"::text AS "payoutSats",
                e."grossPayoutSats"::text AS "grossPayoutSats",
                e."creditedDifficulty"::text AS "creditedDifficulty",
                e."payoutWeight"::text AS "payoutWeight"
            FROM latest_snapshot s
            JOIN "payout_snapshot_entry" e ON e."snapshotId" = s."id"
            WHERE e."address" = $1
              AND e."payoutMode" = $2
              AND e."includedInCoinbase" = true
              AND e."payoutSats" > 0
            LIMIT 1
        `, [address, PPLNS_PAYOUT_MODE]);

        if (row == null) {
            return null;
        }

        const payoutSats = this.toNumber(row.payoutSats);
        const coinbaseValueSats = this.toNumber(row.coinbaseValueSats);
        return {
            snapshotId: row.snapshotId,
            blockHeight: this.toNumber(row.blockHeight),
            payoutMode: row.payoutMode,
            payoutSats,
            grossPayoutSats: this.toNumber(row.grossPayoutSats),
            creditedDifficulty: this.toNumber(row.creditedDifficulty),
            payoutWeight: this.toNumber(row.payoutWeight),
            coinbaseValueSats,
            distributedSats: this.toNumber(row.distributedSats),
            totalCreditedDifficulty: this.toNumber(row.totalCreditedDifficulty),
            includedOutputCount: this.toNumber(row.includedOutputCount),
            createdAt: row.createdAt,
            percent: coinbaseValueSats > 0 ? (payoutSats / coinbaseValueSats) * 100 : 0,
        };
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
                  AND "payoutMode" = $2
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
        `, [windowTargetDifficulty, PPLNS_PAYOUT_MODE]);

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
              AND b."payoutMode" = $3
              AND s."payoutMode" = $3
              AND b."endShareIndex" >= $1::bigint
              AND b."endShareIndex" <= $2::bigint
            GROUP BY s."address"
            HAVING COALESCE(SUM(s."creditedDifficulty"), 0) > 0
        `, [
            window.windowStartShareIndex,
            window.windowEndShareIndex,
            PPLNS_PAYOUT_MODE,
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
        input: {
            blockHeight: number;
            coinbaseValueSats: number;
            windowEndShareIndex: string;
            status: PayoutSnapshotStatus;
        },
    ): Promise<PayoutSnapshotForTemplate | null> {
        const [snapshot] = await manager.query(`
            SELECT "id"::text AS "id"
            FROM "payout_snapshot"
            WHERE "method" = $1
              AND "payoutMode" = $5
              AND "status" = '${input.status}'
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
            PPLNS_PAYOUT_MODE,
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
                "payoutMode",
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
              AND "payoutMode" = $2
        `, [id, PPLNS_PAYOUT_MODE]);
        if (snapshot == null) {
            return null;
        }

        const entries = await manager.query(`
            SELECT
                "address",
                "payoutSats"::text AS "payoutSats"
            FROM "payout_snapshot_entry"
            WHERE "snapshotId" = $1::bigint
              AND "payoutMode" = $2
              AND "includedInCoinbase" = true
            ORDER BY "rank"
        `, [id, PPLNS_PAYOUT_MODE]);
        const coinbaseValue = Number(snapshot.coinbaseValueSats);

        return {
            id: snapshot.id,
            method: snapshot.method,
            payoutMode: snapshot.payoutMode,
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

    private async insertSnapshotEntries(
        manager: EntityManager,
        snapshotId: string,
        entries: PayoutDistributionEntry[],
    ): Promise<void> {
        for (let offset = 0; offset < entries.length; offset += PAYOUT_SNAPSHOT_ENTRY_INSERT_BATCH_SIZE) {
            const batch = entries.slice(offset, offset + PAYOUT_SNAPSHOT_ENTRY_INSERT_BATCH_SIZE);
            await manager.query(`
                INSERT INTO "payout_snapshot_entry" (
                    "snapshotId",
                    "payoutMode",
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
                )
                SELECT
                    $1::bigint,
                    $2,
                    entry."address",
                    entry."creditedDifficulty",
                    entry."acceptedShareCount",
                    entry."payoutWeight",
                    entry."grossPayoutSats",
                    entry."payoutSats",
                    entry."balanceBeforeSats",
                    entry."balanceAfterSats",
                    entry."includedInCoinbase",
                    entry."rowType",
                    entry."rank"
                FROM UNNEST(
                    $3::varchar[],
                    $4::numeric[],
                    $5::bigint[],
                    $6::numeric[],
                    $7::bigint[],
                    $8::bigint[],
                    $9::bigint[],
                    $10::bigint[],
                    $11::boolean[],
                    $12::varchar[],
                    $13::int[]
                ) WITH ORDINALITY AS entry(
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
                    "rank",
                    "ordinality"
                )
                ORDER BY entry."ordinality"
            `, [
                snapshotId,
                PPLNS_PAYOUT_MODE,
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
            ]);
        }
    }

    private limitCoinbaseOutputs(entries: PayoutDistributionEntry[]): PayoutDistributionEntry[] {
        let included = 0;
        let removedPayoutSats = 0;
        const limitedEntries = entries.map(entry => {
            if (!entry.includedInCoinbase) {
                return entry;
            }
            included++;
            if (included <= this.maxCoinbaseOutputs) {
                return entry;
            }
            removedPayoutSats += entry.payoutSats;
            return {
                ...entry,
                payoutSats: 0,
                balanceAfterSats: entry.balanceAfterSats + entry.payoutSats,
                includedInCoinbase: false,
            };
        });

        if (removedPayoutSats <= 0) {
            return limitedEntries;
        }

        const keptActive = limitedEntries
            .filter(entry => entry.includedInCoinbase && entry.creditedDifficulty > 0);
        const keptDifficulty = keptActive.reduce((sum, entry) => sum + entry.creditedDifficulty, 0);
        if (keptDifficulty <= 0) {
            return limitedEntries;
        }

        let assigned = 0;
        const allocations = keptActive
            .map(entry => {
                const exact = (entry.creditedDifficulty * removedPayoutSats) / keptDifficulty;
                const whole = Math.floor(exact);
                assigned += whole;
                return {
                    entry,
                    whole,
                    fraction: exact - whole,
                };
            })
            .sort((a, b) => b.fraction - a.fraction || b.entry.creditedDifficulty - a.entry.creditedDifficulty || a.entry.address.localeCompare(b.entry.address));

        let residual = removedPayoutSats - assigned;
        for (const allocation of allocations) {
            const extra = allocation.whole + (residual > 0 ? 1 : 0);
            if (residual > 0) {
                residual--;
            }
            allocation.entry.payoutSats += extra;
            allocation.entry.balanceAfterSats -= extra;
        }

        return limitedEntries;
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
