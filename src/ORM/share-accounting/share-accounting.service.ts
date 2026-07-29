import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AcceptedShareEntity } from '../accepted-share/accepted-share.entity';
import { RedisMessagingService } from '../../services/redis-messaging.service';
import { normalizePayoutMode, PayoutMode } from '../../types/payout-mode';

export interface AcceptedShareRecord {
    protocol: 'sv1' | 'sv1_tls' | 'sv2' | 'sv2_jdp' | 'datum';
    payoutMode?: PayoutMode;
    workSource?: 'pool_template' | 'miner_template';
    workProtocol?: 'pool' | 'sv2_jdp' | 'datum';
    acceptedAt?: Date;
    address: string;
    clientName: string;
    sessionId: string;
    clientId: string;
    jobId: string;
    jobTemplateId: string;
    blockHeight: number;
    creditedDifficulty: number;
    submissionDifficulty: number;
    networkDifficulty: number;
    nonce: string | number;
    ntime: string | number;
    version: string | number;
    extraNonce2: string;
    isBlockCandidate: boolean;
    blockSubmissionResult?: string | null;
}

export interface ShareAccountingSummary {
    totalAcceptedShares: number;
    totalCreditedDifficulty: number;
    acceptedSharesLast10Minutes: number;
    creditedDifficultyLast10Minutes: number;
    acceptedSharesLastHour: number;
    creditedDifficultyLastHour: number;
    acceptedSharesLastDay: number;
    creditedDifficultyLastDay: number;
    hashRateLast10Minutes: number;
    hashRateLastHour: number;
    bestSubmissionDifficulty: number;
    bestSubmissionDifficultyAt: string | null;
    workSinceLastBlock: number;
    currentRoundAcceptedShares: number;
    currentRoundNetworkDifficulty: number;
    networkDifficultyPercent: number;
    blockCandidateCount: number;
    latestShareAt: string | null;
    protocolBreakdown: {
        protocol: string;
        acceptedShares: number;
        creditedDifficulty: number;
    }[];
}

export interface SessionShareSummary {
    clientId: string;
    latestShareAt: string | null;
    hashRateLast10Minutes: number;
    bestSubmissionDifficulty: number;
}

export interface ShareRollupBatchResult {
    processed: boolean;
    reason?: 'disabled' | 'locked' | 'no-shares';
    payoutMode?: PayoutMode;
    batchId?: string;
    startShareIndex?: string;
    endShareIndex?: string;
    acceptedShareCount?: number;
    creditedDifficulty?: number;
}

interface AccountingFilter {
    address?: string;
    clientName?: string;
    clientId?: string;
    payoutMode?: PayoutMode;
}

const HASHES_PER_DIFFICULTY = 4294967296;
const ROLLUP_BUCKET_SECONDS = 600;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_FLUSH_INTERVAL_MS = 25;
const DEFAULT_MAX_QUEUE_SIZE = 50000;
const DEFAULT_SUMMARY_CACHE_MS = 2500;
const DEFAULT_SUMMARY_CACHE_MAX = 10000;
const DEFAULT_REDIS_SUMMARY_CACHE_MS = 30000;
const DEFAULT_ROLLUP_INTERVAL_MS = 60000;
const DEFAULT_ROLLUP_SAFETY_LAG_SECONDS = 10;
const DEFAULT_ROLLUP_MAX_SHARES_PER_BATCH = 5000000;
const SHARE_ROLLUP_ADVISORY_LOCK = '1780962600';

@Injectable()
export class ShareAccountingService implements OnModuleInit, OnModuleDestroy {
    private pendingShares: PendingShare[] = [];
    private flushTimer: NodeJS.Timeout | null = null;
    private activeFlush: Promise<void> | null = null;
    private rollupTimer: NodeJS.Timeout | null = null;
    private activeRollup: Promise<void> | null = null;
    private summaryCache = new Map<string, SummaryCacheEntry>();
    private readonly poolSummaryCacheKey = 'accounting:pool-summary';
    private readonly batchSize = this.readPositiveInt('SHARE_ACCOUNTING_BATCH_SIZE', DEFAULT_BATCH_SIZE);
    private readonly flushIntervalMs = this.readPositiveInt('SHARE_ACCOUNTING_FLUSH_INTERVAL_MS', DEFAULT_FLUSH_INTERVAL_MS);
    private readonly maxQueueSize = this.readPositiveInt('SHARE_ACCOUNTING_MAX_QUEUE_SIZE', DEFAULT_MAX_QUEUE_SIZE);
    private readonly summaryCacheMs = this.readNonNegativeInt('SHARE_ACCOUNTING_SUMMARY_CACHE_MS', DEFAULT_SUMMARY_CACHE_MS);
    private readonly summaryCacheMax = this.readPositiveInt('SHARE_ACCOUNTING_SUMMARY_CACHE_MAX', DEFAULT_SUMMARY_CACHE_MAX);
    private readonly redisSummaryCacheMs = this.readNonNegativeInt('SHARE_ACCOUNTING_REDIS_SUMMARY_CACHE_MS', DEFAULT_REDIS_SUMMARY_CACHE_MS);
    private readonly shareRollupEnabled = this.readBoolean('SHARE_ROLLUP_ENABLED', true);
    private readonly shareRollupIntervalMs = this.readPositiveInt('SHARE_ROLLUP_INTERVAL_MS', DEFAULT_ROLLUP_INTERVAL_MS);
    private readonly shareRollupSafetyLagSeconds = this.readNonNegativeInt('SHARE_ROLLUP_SAFETY_LAG_SECONDS', DEFAULT_ROLLUP_SAFETY_LAG_SECONDS);
    private readonly shareRollupMaxSharesPerBatch = this.readPositiveInt('SHARE_ROLLUP_MAX_SHARES_PER_BATCH', DEFAULT_ROLLUP_MAX_SHARES_PER_BATCH);

    constructor(
        @InjectRepository(AcceptedShareEntity)
        private readonly acceptedShareRepository: Repository<AcceptedShareEntity>,
        private readonly redisMessagingService?: RedisMessagingService,
    ) { }

    public onModuleInit(): void {
        this.startShareRollupTimer();
    }

    public async recordAcceptedShare(record: AcceptedShareRecord): Promise<AcceptedShareEntity> {
        const acceptedShare = this.acceptedShareRepository.create({
            ...record,
            payoutMode: normalizePayoutMode(record.payoutMode),
            workSource: record.workSource ?? 'pool_template',
            workProtocol: record.workProtocol ?? 'pool',
            acceptedAt: record.acceptedAt ?? new Date(),
            nonce: record.nonce.toString(),
            ntime: record.ntime.toString(),
            version: record.version.toString(),
            blockSubmissionResult: record.blockSubmissionResult == null
                ? null
                : record.blockSubmissionResult.toString(),
        });

        if (this.pendingShares.length >= this.maxQueueSize) {
            throw new Error(`Share accounting queue is full (${this.maxQueueSize})`);
        }

        return await new Promise<AcceptedShareEntity>((resolve, reject) => {
            this.pendingShares.push({ entity: acceptedShare, resolve, reject });

            if (this.pendingShares.length >= this.batchSize) {
                this.startFlush();
                return;
            }

            this.scheduleFlush();
        });
    }

    public async flushPendingShares(): Promise<void> {
        while (this.pendingShares.length > 0 || this.activeFlush != null) {
            if (this.activeFlush != null) {
                await this.activeFlush;
                continue;
            }

            this.startFlush();
        }
    }

    public async onModuleDestroy(): Promise<void> {
        if (this.rollupTimer != null) {
            clearInterval(this.rollupTimer);
            this.rollupTimer = null;
        }
        if (this.activeRollup != null) {
            await this.activeRollup;
        }
        await this.flushPendingShares();
    }

    public async processPendingShareRollupBatch(): Promise<ShareRollupBatchResult> {
        if (!this.shareRollupEnabled) {
            return { processed: false, reason: 'disabled' };
        }

        return this.acceptedShareRepository.manager.transaction(async manager => {
            const [lockRow] = await manager.query(`
                SELECT pg_try_advisory_xact_lock($1::bigint) AS "locked"
            `, [SHARE_ROLLUP_ADVISORY_LOCK]);

            if (lockRow?.locked !== true) {
                return { processed: false, reason: 'locked' };
            }

            const payoutMode: PayoutMode = 'pplns';
            const [lastRow] = await manager.query(`
                SELECT COALESCE(MAX("endShareIndex"), 0)::text AS "lastProcessedShareIndex"
                FROM "share_rollup_batch"
                WHERE "status" = 'finalized'
                  AND "payoutMode" = $1
            `, [payoutMode]);
            const lastProcessedShareIndex = lastRow?.lastProcessedShareIndex ?? '0';

            const [rangeRow] = await manager.query(`
                WITH last_state AS MATERIALIZED (
                    SELECT $1::bigint AS "lastProcessedShareIndex"
                ),
                first_unstable AS MATERIALIZED (
                    SELECT MIN("shareIndex") AS "firstUnstableShareIndex"
                    FROM "accepted_share_entity", last_state
                    WHERE "shareIndex" > last_state."lastProcessedShareIndex"
                      AND "payoutMode" = $4
                      AND "acceptedAt" > NOW() - ($2::int * INTERVAL '1 second')
                ),
                stable_bound AS MATERIALIZED (
                    SELECT
                        CASE
                            WHEN (SELECT "firstUnstableShareIndex" FROM first_unstable) IS NULL THEN (
                                SELECT MAX("shareIndex")
                                FROM "accepted_share_entity", last_state
                                WHERE "shareIndex" > last_state."lastProcessedShareIndex"
                                  AND "payoutMode" = $4
                            )
                            ELSE (SELECT "firstUnstableShareIndex" FROM first_unstable) - 1
                        END AS "maxStableShareIndex"
                ),
                bounded AS MATERIALIZED (
                    SELECT "shareIndex"
                    FROM "accepted_share_entity", last_state, stable_bound
                    WHERE "shareIndex" > last_state."lastProcessedShareIndex"
                      AND "shareIndex" <= stable_bound."maxStableShareIndex"
                      AND "payoutMode" = $4
                    ORDER BY "shareIndex" ASC
                    LIMIT $3::int
                )
                SELECT
                    MIN("shareIndex")::text AS "startShareIndex",
                    MAX("shareIndex")::text AS "endShareIndex",
                    COUNT(*)::int AS "acceptedShareCount"
                FROM bounded
            `, [
                lastProcessedShareIndex,
                this.shareRollupSafetyLagSeconds,
                this.shareRollupMaxSharesPerBatch,
                payoutMode,
            ]);

            if (rangeRow?.startShareIndex == null || rangeRow?.endShareIndex == null || this.toNumber(rangeRow.acceptedShareCount) === 0) {
                return { processed: false, reason: 'no-shares' };
            }

            const [statsRow] = await manager.query(`
                SELECT
                    MIN("acceptedAt") AS "startAcceptedAt",
                    MAX("acceptedAt") AS "endAcceptedAt",
                    COUNT(*)::bigint AS "acceptedShareCount",
                    COALESCE(SUM("creditedDifficulty"), 0)::numeric AS "creditedDifficulty"
                FROM "accepted_share_entity"
                WHERE "shareIndex" >= $1::bigint
                  AND "shareIndex" <= $2::bigint
                  AND "payoutMode" = $3
            `, [rangeRow.startShareIndex, rangeRow.endShareIndex, payoutMode]);

            if (statsRow?.startAcceptedAt == null || this.toNumber(statsRow.acceptedShareCount) === 0) {
                return { processed: false, reason: 'no-shares' };
            }

            const [batchRow] = await manager.query(`
                INSERT INTO "share_rollup_batch" (
                    "startShareIndex",
                    "endShareIndex",
                    "payoutMode",
                    "startAcceptedAt",
                    "endAcceptedAt",
                    "acceptedShareCount",
                    "creditedDifficulty",
                    "status",
                    "finalizedAt"
                ) VALUES (
                    $1::bigint,
                    $2::bigint,
                    $3,
                    $4::timestamptz,
                    $5::timestamptz,
                    $6::bigint,
                    $7::numeric,
                    'finalized',
                    NOW()
                )
                RETURNING "id"::text AS "batchId"
            `, [
                rangeRow.startShareIndex,
                rangeRow.endShareIndex,
                payoutMode,
                statsRow.startAcceptedAt,
                statsRow.endAcceptedAt,
                statsRow.acceptedShareCount,
                statsRow.creditedDifficulty,
            ]);

            await manager.query(`
                INSERT INTO "share_rollup_batch_summary" (
                    "batchId",
                    "payoutMode",
                    "address",
                    "clientName",
                    "protocol",
                    "blockHeight",
                    "creditedDifficulty",
                    "acceptedShareCount",
                    "bestSubmissionDifficulty",
                    "firstShareAt",
                    "lastShareAt"
                )
                SELECT
                    $1::bigint AS "batchId",
                    "payoutMode",
                    "address",
                    "clientName",
                    "protocol",
                    "blockHeight",
                    SUM("creditedDifficulty") AS "creditedDifficulty",
                    COUNT(*)::bigint AS "acceptedShareCount",
                    MAX("submissionDifficulty") AS "bestSubmissionDifficulty",
                    MIN("acceptedAt") AS "firstShareAt",
                    MAX("acceptedAt") AS "lastShareAt"
                FROM "accepted_share_entity"
                WHERE "shareIndex" >= $2::bigint
                  AND "shareIndex" <= $3::bigint
                  AND "payoutMode" = $4
                GROUP BY "payoutMode", "address", "clientName", "protocol", "blockHeight"
            `, [
                batchRow.batchId,
                rangeRow.startShareIndex,
                rangeRow.endShareIndex,
                payoutMode,
            ]);

            return {
                processed: true,
                payoutMode,
                batchId: batchRow.batchId,
                startShareIndex: rangeRow.startShareIndex,
                endShareIndex: rangeRow.endShareIndex,
                acceptedShareCount: this.toNumber(statsRow.acceptedShareCount),
                creditedDifficulty: this.toNumber(statsRow.creditedDifficulty),
            };
        });
    }

    public async getPoolSummary(payoutMode?: PayoutMode): Promise<ShareAccountingSummary> {
        const mode = payoutMode == null ? undefined : normalizePayoutMode(payoutMode);
        const poolSummaryCacheKey = mode == null ? this.poolSummaryCacheKey : `${this.poolSummaryCacheKey}:${mode}`;
        const cached = await this.redisMessagingService
            ?.getJsonCache<ShareAccountingSummary>(poolSummaryCacheKey)
            .catch(error => {
                console.error(`Pool accounting summary cache read failed: ${error.message}`);
                return null;
            });
        if (cached != null) {
            return cached;
        }

        return this.withPoolRollupOverlay(await this.getSummary({ payoutMode: mode }), mode);
    }

    public async refreshPoolSummary(payoutMode?: PayoutMode): Promise<ShareAccountingSummary> {
        const mode = payoutMode == null ? undefined : normalizePayoutMode(payoutMode);
        const poolSummaryCacheKey = mode == null ? this.poolSummaryCacheKey : `${this.poolSummaryCacheKey}:${mode}`;
        const summary = await this.withPoolRollupOverlay(await this.getSummary({ payoutMode: mode }), mode);
        await this.redisMessagingService
            ?.setJsonCache(poolSummaryCacheKey, summary, 10 * 60 * 1000)
            .catch(error => {
                console.error(`Pool accounting summary cache write failed: ${error.message}`);
            });
        return summary;
    }

    private async withPoolRollupOverlay(summary: ShareAccountingSummary, payoutMode?: PayoutMode): Promise<ShareAccountingSummary> {
        const [currentRoundRow] = await this.acceptedShareRepository.query(`
                WITH latest_found_block AS (
                    SELECT COALESCE(MAX("height"), 0) AS "height"
                    FROM "blocks_entity"
                    ${payoutMode == null ? '' : 'WHERE "payoutMode" = $1'}
                ),
                filtered_rows AS (
                    SELECT "accepted_share_block_10m".*
                    FROM "accepted_share_block_10m", latest_found_block
                    WHERE "blockHeight" > latest_found_block."height"
                      ${payoutMode == null ? '' : 'AND "payoutMode" = $1'}
                ),
                best_share AS (
                    SELECT
                        "bestSubmissionDifficulty",
                        "bucket"
                    FROM filtered_rows
                    ORDER BY "bestSubmissionDifficulty" DESC, "bucket" DESC
                    LIMIT 1
                )
                SELECT
                    COALESCE(SUM("acceptedCount"), 0)::int AS "currentRoundAcceptedShares",
                    COALESCE(SUM("shares"), 0)::float AS "workSinceLastBlock",
                    COALESCE(MAX("networkDifficulty"), 0)::float AS "currentRoundNetworkDifficulty",
                    COALESCE((SELECT "bestSubmissionDifficulty" FROM best_share), 0)::float AS "bestSubmissionDifficulty",
                    (SELECT "bucket" FROM best_share) AS "bestSubmissionDifficultyAt"
            FROM filtered_rows
        `, payoutMode == null ? [] : [payoutMode]);
        const currentRoundNetworkDifficulty = this.toNumber(currentRoundRow?.currentRoundNetworkDifficulty);
        const workSinceLastBlock = this.toNumber(currentRoundRow?.workSinceLastBlock);
        const liveBestSubmissionDifficulty = this.toNumber(currentRoundRow?.bestSubmissionDifficulty);
        const liveBestSubmissionDifficultyAt = currentRoundRow?.bestSubmissionDifficultyAt == null
            ? null
            : new Date(currentRoundRow.bestSubmissionDifficultyAt).toISOString();
        const retainedBest = await this.getRetainedBestSubmissionDifficulty(payoutMode);
        const retainedBestSubmissionDifficulty = this.toNumber(retainedBest?.bestSubmissionDifficulty);
        const useRetainedBest = retainedBestSubmissionDifficulty > liveBestSubmissionDifficulty;

        return {
            ...summary,
            bestSubmissionDifficulty: useRetainedBest
                ? retainedBestSubmissionDifficulty
                : liveBestSubmissionDifficulty,
            bestSubmissionDifficultyAt: useRetainedBest
                ? retainedBest?.bestSubmissionDifficultyAt ?? null
                : liveBestSubmissionDifficultyAt,
            workSinceLastBlock,
            currentRoundAcceptedShares: this.toNumber(currentRoundRow?.currentRoundAcceptedShares),
            currentRoundNetworkDifficulty,
            networkDifficultyPercent: currentRoundNetworkDifficulty > 0
                ? this.roundPercent((workSinceLastBlock / currentRoundNetworkDifficulty) * 100)
                : 0,
        };
    }

    private async getRetainedBestSubmissionDifficulty(payoutMode?: PayoutMode): Promise<{
        bestSubmissionDifficulty: number;
        bestSubmissionDifficultyAt: string | null;
    } | null> {
        try {
            const [row] = await this.acceptedShareRepository.query(`
                SELECT
                    "submissionDifficulty"::float AS "bestSubmissionDifficulty",
                    "acceptedAt" AS "bestSubmissionDifficultyAt"
                FROM "accepted_share_high_score"
                WHERE "scope" = 'all_time'
                  AND "payoutMode" = $1
                ORDER BY "submissionDifficulty" DESC, "acceptedAt" DESC
                LIMIT 1
            `, [payoutMode ?? 'all']);

            if (row == null) {
                return null;
            }

            return {
                bestSubmissionDifficulty: this.toNumber(row.bestSubmissionDifficulty),
                bestSubmissionDifficultyAt: row.bestSubmissionDifficultyAt == null
                    ? null
                    : new Date(row.bestSubmissionDifficultyAt).toISOString(),
            };
        } catch (error) {
            if (error?.code === '42P01') {
                return null;
            }
            throw error;
        }
    }

    public emptySummary(): ShareAccountingSummary {
        return {
            totalAcceptedShares: 0,
            totalCreditedDifficulty: 0,
            acceptedSharesLast10Minutes: 0,
            creditedDifficultyLast10Minutes: 0,
            acceptedSharesLastHour: 0,
            creditedDifficultyLastHour: 0,
            acceptedSharesLastDay: 0,
            creditedDifficultyLastDay: 0,
            hashRateLast10Minutes: 0,
            hashRateLastHour: 0,
            bestSubmissionDifficulty: 0,
            bestSubmissionDifficultyAt: null,
            workSinceLastBlock: 0,
            currentRoundAcceptedShares: 0,
            currentRoundNetworkDifficulty: 0,
            networkDifficultyPercent: 0,
            blockCandidateCount: 0,
            latestShareAt: null,
            protocolBreakdown: [],
        };
    }

    public async getAddressSummary(address: string, payoutMode?: PayoutMode): Promise<ShareAccountingSummary> {
        return this.getSummary({ address, payoutMode });
    }

    public async getWorkerGroupSummary(address: string, clientName: string, payoutMode?: PayoutMode): Promise<ShareAccountingSummary> {
        return this.getSummary({ address, clientName, payoutMode });
    }

    public async getSessionSummary(clientId: string, payoutMode?: PayoutMode): Promise<ShareAccountingSummary> {
        return this.getSummary({ clientId, payoutMode });
    }

    public async getSessionSummaries(clientIds: string[]): Promise<Map<string, SessionShareSummary>> {
        const uniqueClientIds = [...new Set(clientIds.filter(clientId => clientId != null))];
        const summaries = new Map<string, SessionShareSummary>();
        if (uniqueClientIds.length === 0 || process.env.API_ONLY === 'true') {
            return summaries;
        }

        const rows = await this.acceptedShareRepository.query(`
            WITH clock AS MATERIALIZED (
                SELECT
                    time_bucket(INTERVAL '10 minutes', NOW()) AS "currentBucket"
            ),
            latest_bucket AS MATERIALIZED (
                SELECT "bucket"
                FROM "accepted_share_10m", clock
                WHERE "bucket" < clock."currentBucket"
                ORDER BY "bucket" DESC
                LIMIT 1
            ),
            bounds AS MATERIALIZED (
                SELECT
                    "currentBucket",
                    COALESCE(
                        (SELECT "bucket" FROM latest_bucket),
                        "currentBucket" - INTERVAL '10 minutes'
                    ) AS "latestCompletedBucket"
                FROM clock
            ),
            filtered_rows AS (
                SELECT "accepted_share_10m".*, bounds."latestCompletedBucket"
                FROM "accepted_share_10m", bounds
                WHERE "clientId" = ANY($1::uuid[])
            )
            SELECT
                "clientId",
                MAX("bucket") AS "latestShareAt",
                COALESCE((SUM("shares") FILTER (WHERE "bucket" = "latestCompletedBucket") * ${HASHES_PER_DIFFICULTY}) / ${ROLLUP_BUCKET_SECONDS}, 0)::float AS "hashRateLast10Minutes"
            FROM filtered_rows
            GROUP BY "clientId"
        `, [uniqueClientIds]);

        rows.forEach(row => {
            summaries.set(row.clientId, {
                clientId: row.clientId,
                latestShareAt: row.latestShareAt == null
                    ? null
                    : new Date(row.latestShareAt).toISOString(),
                hashRateLast10Minutes: this.toNumber(row.hashRateLast10Minutes),
                bestSubmissionDifficulty: 0,
            });
        });

        return summaries;
    }

    private async getSummary(filter: AccountingFilter): Promise<ShareAccountingSummary> {
        const cacheKey = this.getSummaryCacheKey(filter);
        const cached = this.summaryCache.get(cacheKey);
        const now = Date.now();

        if (cached != null && cached.expiresAt > now) {
            return cached.value;
        }

        const value = this.loadCachedSummary(filter, cacheKey).catch(error => {
            this.summaryCache.delete(cacheKey);
            throw error;
        });

        if (this.summaryCacheMs > 0) {
            this.summaryCache.set(cacheKey, {
                expiresAt: now + this.summaryCacheMs,
                value,
            });
            this.trimSummaryCache();
        }

        return value;
    }

    private async loadCachedSummary(filter: AccountingFilter, cacheKey: string): Promise<ShareAccountingSummary> {
        const redisCacheKey = `accounting:summary:${cacheKey}`;
        const cached = await this.redisMessagingService
            ?.getJsonCache<ShareAccountingSummary>(redisCacheKey)
            .catch(error => {
                console.error(`Share accounting summary cache read failed: ${error.message}`);
                return null;
            });
        if (cached != null) {
            return cached;
        }

        const summary = await this.loadSummary(filter);

        await this.redisMessagingService
            ?.setJsonCache(redisCacheKey, summary, this.redisSummaryCacheMs)
            .catch(error => {
                console.error(`Share accounting summary cache write failed: ${error.message}`);
            });

        return summary;
    }

    private async loadSummary(filter: AccountingFilter): Promise<ShareAccountingSummary> {
        if (this.isPoolSummaryFilter(filter)) {
            try {
                return await this.loadPoolSummary(filter.payoutMode);
            } catch (error) {
                if (error?.code !== '42P01') {
                    throw error;
                }
            }
        }

        const { whereSql, params } = this.buildWhereClause(filter);
        const [summary] = await this.acceptedShareRepository.query(`
            WITH clock AS MATERIALIZED (
                SELECT
                    time_bucket(INTERVAL '10 minutes', NOW()) AS "currentBucket"
            ),
            latest_bucket AS MATERIALIZED (
                SELECT "bucket"
                FROM "accepted_share_10m", clock
                WHERE "bucket" < clock."currentBucket"
                ORDER BY "bucket" DESC
                LIMIT 1
            ),
            bounds AS MATERIALIZED (
                SELECT
                    "currentBucket",
                    COALESCE(
                        (SELECT "bucket" FROM latest_bucket),
                        "currentBucket" - INTERVAL '10 minutes'
                    ) AS "latestCompletedBucket"
                FROM clock
            ),
            filtered_rows AS (
                SELECT "accepted_share_10m".*, bounds."currentBucket", bounds."latestCompletedBucket"
                FROM "accepted_share_10m", bounds
                ${whereSql.length > 0
                    ? `${whereSql} AND "accepted_share_10m"."bucket" <= bounds."latestCompletedBucket"`
                    : `WHERE "accepted_share_10m"."bucket" <= bounds."latestCompletedBucket"`}
            )
            SELECT
                COALESCE(SUM("acceptedCount"), 0)::int AS "totalAcceptedShares",
                COALESCE(SUM("shares"), 0)::float AS "totalCreditedDifficulty",
                COALESCE(SUM("acceptedCount") FILTER (WHERE "bucket" = "latestCompletedBucket"), 0)::int AS "acceptedSharesLast10Minutes",
                COALESCE(SUM("shares") FILTER (WHERE "bucket" = "latestCompletedBucket"), 0)::float AS "creditedDifficultyLast10Minutes",
                COALESCE(SUM("acceptedCount") FILTER (WHERE "bucket" > "latestCompletedBucket" - INTERVAL '1 hour' AND "bucket" <= "latestCompletedBucket"), 0)::int AS "acceptedSharesLastHour",
                COALESCE(SUM("shares") FILTER (WHERE "bucket" > "latestCompletedBucket" - INTERVAL '1 hour' AND "bucket" <= "latestCompletedBucket"), 0)::float AS "creditedDifficultyLastHour",
                COALESCE(SUM("acceptedCount") FILTER (WHERE "bucket" > "latestCompletedBucket" - INTERVAL '1 day' AND "bucket" <= "latestCompletedBucket"), 0)::int AS "acceptedSharesLastDay",
                COALESCE(SUM("shares") FILTER (WHERE "bucket" > "latestCompletedBucket" - INTERVAL '1 day' AND "bucket" <= "latestCompletedBucket"), 0)::float AS "creditedDifficultyLastDay",
                COALESCE((SUM("shares") FILTER (WHERE "bucket" = "latestCompletedBucket") * ${HASHES_PER_DIFFICULTY}) / ${ROLLUP_BUCKET_SECONDS}, 0)::float AS "hashRateLast10Minutes",
                COALESCE((SUM("shares") FILTER (WHERE "bucket" > "latestCompletedBucket" - INTERVAL '1 hour' AND "bucket" <= "latestCompletedBucket") * ${HASHES_PER_DIFFICULTY}) / 3600, 0)::float AS "hashRateLastHour",
                MAX("bucket") AS "latestShareAt"
            FROM filtered_rows
        `, params);

        return this.mapSummaryRow(summary);
    }

    private async loadPoolSummary(payoutMode?: PayoutMode): Promise<ShareAccountingSummary> {
        const params = payoutMode == null ? [] : [payoutMode];
        const whereSql = payoutMode == null
            ? 'WHERE "accepted_share_pool_10m"."bucket" <= bounds."latestCompletedBucket"'
            : 'WHERE "accepted_share_pool_10m"."payoutMode" = $1 AND "accepted_share_pool_10m"."bucket" <= bounds."latestCompletedBucket"';
        const [summary] = await this.acceptedShareRepository.query(`
            WITH clock AS MATERIALIZED (
                SELECT
                    time_bucket(INTERVAL '10 minutes', NOW()) AS "currentBucket"
            ),
            latest_bucket AS MATERIALIZED (
                SELECT "bucket"
                FROM "accepted_share_pool_10m", clock
                WHERE "bucket" < clock."currentBucket"
                ORDER BY "bucket" DESC
                LIMIT 1
            ),
            bounds AS MATERIALIZED (
                SELECT
                    "currentBucket",
                    COALESCE(
                        (SELECT "bucket" FROM latest_bucket),
                        "currentBucket" - INTERVAL '10 minutes'
                    ) AS "latestCompletedBucket"
                FROM clock
            ),
            filtered_rows AS (
                SELECT "accepted_share_pool_10m".*, bounds."currentBucket", bounds."latestCompletedBucket"
                FROM "accepted_share_pool_10m", bounds
                ${whereSql}
            )
            SELECT
                COALESCE(SUM("acceptedCount"), 0)::int AS "totalAcceptedShares",
                COALESCE(SUM("shares"), 0)::float AS "totalCreditedDifficulty",
                COALESCE(SUM("acceptedCount") FILTER (WHERE "bucket" = "latestCompletedBucket"), 0)::int AS "acceptedSharesLast10Minutes",
                COALESCE(SUM("shares") FILTER (WHERE "bucket" = "latestCompletedBucket"), 0)::float AS "creditedDifficultyLast10Minutes",
                COALESCE(SUM("acceptedCount") FILTER (WHERE "bucket" > "latestCompletedBucket" - INTERVAL '1 hour' AND "bucket" <= "latestCompletedBucket"), 0)::int AS "acceptedSharesLastHour",
                COALESCE(SUM("shares") FILTER (WHERE "bucket" > "latestCompletedBucket" - INTERVAL '1 hour' AND "bucket" <= "latestCompletedBucket"), 0)::float AS "creditedDifficultyLastHour",
                COALESCE(SUM("acceptedCount") FILTER (WHERE "bucket" > "latestCompletedBucket" - INTERVAL '1 day' AND "bucket" <= "latestCompletedBucket"), 0)::int AS "acceptedSharesLastDay",
                COALESCE(SUM("shares") FILTER (WHERE "bucket" > "latestCompletedBucket" - INTERVAL '1 day' AND "bucket" <= "latestCompletedBucket"), 0)::float AS "creditedDifficultyLastDay",
                COALESCE((SUM("shares") FILTER (WHERE "bucket" = "latestCompletedBucket") * ${HASHES_PER_DIFFICULTY}) / ${ROLLUP_BUCKET_SECONDS}, 0)::float AS "hashRateLast10Minutes",
                COALESCE((SUM("shares") FILTER (WHERE "bucket" > "latestCompletedBucket" - INTERVAL '1 hour' AND "bucket" <= "latestCompletedBucket") * ${HASHES_PER_DIFFICULTY}) / 3600, 0)::float AS "hashRateLastHour",
                MAX("bucket") AS "latestShareAt"
            FROM filtered_rows
        `, params);

        return this.mapSummaryRow(summary);
    }

    private mapSummaryRow(summary: Record<string, unknown> | undefined): ShareAccountingSummary {
        return {
            totalAcceptedShares: this.toNumber(summary?.totalAcceptedShares),
            totalCreditedDifficulty: this.toNumber(summary?.totalCreditedDifficulty),
            acceptedSharesLast10Minutes: this.toNumber(summary?.acceptedSharesLast10Minutes),
            creditedDifficultyLast10Minutes: this.toNumber(summary?.creditedDifficultyLast10Minutes),
            acceptedSharesLastHour: this.toNumber(summary?.acceptedSharesLastHour),
            creditedDifficultyLastHour: this.toNumber(summary?.creditedDifficultyLastHour),
            acceptedSharesLastDay: this.toNumber(summary?.acceptedSharesLastDay),
            creditedDifficultyLastDay: this.toNumber(summary?.creditedDifficultyLastDay),
            hashRateLast10Minutes: this.toNumber(summary?.hashRateLast10Minutes),
            hashRateLastHour: this.toNumber(summary?.hashRateLastHour),
            bestSubmissionDifficulty: 0,
            bestSubmissionDifficultyAt: null,
            workSinceLastBlock: 0,
            currentRoundAcceptedShares: 0,
            currentRoundNetworkDifficulty: 0,
            networkDifficultyPercent: 0,
            blockCandidateCount: 0,
            latestShareAt: summary?.latestShareAt == null
                ? null
                : new Date(summary.latestShareAt as string | Date).toISOString(),
            protocolBreakdown: [],
        };
    }

    private isPoolSummaryFilter(filter: AccountingFilter): boolean {
        return filter.address == null
            && filter.clientName == null
            && filter.clientId == null;
    }

    private scheduleFlush(): void {
        if (this.flushTimer != null || this.activeFlush != null) {
            return;
        }

        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.startFlush();
        }, this.flushIntervalMs);
        this.flushTimer.unref?.();
    }

    private startFlush(): void {
        if (this.activeFlush != null) {
            return;
        }

        if (this.flushTimer != null) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        const batch = this.pendingShares.splice(0, this.batchSize);
        if (batch.length === 0) {
            return;
        }

        this.activeFlush = this.flushBatch(batch).finally(() => {
            this.activeFlush = null;

            if (this.pendingShares.length >= this.batchSize) {
                this.startFlush();
                return;
            }

            if (this.pendingShares.length > 0) {
                this.scheduleFlush();
            }
        });
    }

    private async flushBatch(batch: PendingShare[]): Promise<void> {
        try {
            await this.acceptedShareRepository.insert(batch.map(item => item.entity));
            batch.forEach(item => item.resolve(item.entity));
        } catch (error) {
            batch.forEach(item => item.reject(error));
        }
    }

    private startShareRollupTimer(): void {
        if (!this.shareRollupEnabled || process.env.MASTER !== 'true') {
            return;
        }

        this.rollupTimer = setInterval(() => {
            if (this.activeRollup != null) {
                return;
            }

            this.activeRollup = this.processPendingShareRollupBatch()
                .then(result => {
                    if (result.processed) {
                        console.log(`Share rollup batch ${result.batchId} finalized: indexes ${result.startShareIndex}-${result.endShareIndex}, shares ${result.acceptedShareCount}, difficulty ${result.creditedDifficulty}`);
                    }
                })
                .catch(error => {
                    console.error(`Share rollup batch failed: ${error.message}`);
                })
                .finally(() => {
                    this.activeRollup = null;
                });
        }, this.shareRollupIntervalMs);
        this.rollupTimer.unref?.();
    }

    private buildWhereClause(filter: AccountingFilter): { whereSql: string; params: string[] } {
        const where: string[] = [];
        const params: string[] = [];

        if (filter.address != null) {
            params.push(filter.address);
            where.push(`"address" = $${params.length}`);
        }
        if (filter.clientName != null) {
            params.push(filter.clientName);
            where.push(`"clientName" = $${params.length}`);
        }
        if (filter.clientId != null) {
            params.push(filter.clientId);
            where.push(`"clientId" = $${params.length}`);
        }
        if (filter.payoutMode != null) {
            params.push(filter.payoutMode);
            where.push(`"payoutMode" = $${params.length}`);
        }

        return {
            whereSql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
            params,
        };
    }

    private toNumber(value: unknown): number {
        const parsed = Number(value ?? 0);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    private roundPercent(value: number): number {
        return Math.round(value * 1_000_000) / 1_000_000;
    }

    private getSummaryCacheKey(filter: AccountingFilter): string {
        return JSON.stringify({
            address: filter.address ?? null,
            clientName: filter.clientName ?? null,
            clientId: filter.clientId ?? null,
            payoutMode: filter.payoutMode ?? null,
        });
    }

    private trimSummaryCache(): void {
        while (this.summaryCache.size > this.summaryCacheMax) {
            const firstKey = this.summaryCache.keys().next().value;
            if (firstKey == null) {
                return;
            }
            this.summaryCache.delete(firstKey);
        }
    }

    private readPositiveInt(name: string, defaultValue: number): number {
        const value = Number(process.env[name]);
        return Number.isInteger(value) && value > 0 ? value : defaultValue;
    }

    private readNonNegativeInt(name: string, defaultValue: number): number {
        const value = Number(process.env[name]);
        return Number.isInteger(value) && value >= 0 ? value : defaultValue;
    }

    private readBoolean(name: string, defaultValue: boolean): boolean {
        const value = process.env[name]?.toLowerCase();
        if (value == null || value.length === 0) {
            return defaultValue;
        }
        return value === 'true' || value === '1' || value === 'yes';
    }
}

interface PendingShare {
    entity: AcceptedShareEntity;
    resolve: (entity: AcceptedShareEntity) => void;
    reject: (error: unknown) => void;
}

interface SummaryCacheEntry {
    expiresAt: number;
    value: Promise<ShareAccountingSummary>;
}
