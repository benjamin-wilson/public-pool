import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AcceptedShareEntity } from '../accepted-share/accepted-share.entity';
import { RedisMessagingService } from '../../services/redis-messaging.service';

export interface AcceptedShareRecord {
    protocol: 'sv1' | 'sv2';
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

interface AccountingFilter {
    address?: string;
    clientName?: string;
    clientId?: string;
}

const HASHES_PER_DIFFICULTY = 4294967296;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_FLUSH_INTERVAL_MS = 25;
const DEFAULT_MAX_QUEUE_SIZE = 50000;
const DEFAULT_SUMMARY_CACHE_MS = 2500;
const DEFAULT_SUMMARY_CACHE_MAX = 10000;

@Injectable()
export class ShareAccountingService implements OnModuleDestroy {
    private pendingShares: PendingShare[] = [];
    private flushTimer: NodeJS.Timeout | null = null;
    private activeFlush: Promise<void> | null = null;
    private summaryCache = new Map<string, SummaryCacheEntry>();
    private readonly poolSummaryCacheKey = 'accounting:pool-summary';
    private readonly batchSize = this.readPositiveInt('SHARE_ACCOUNTING_BATCH_SIZE', DEFAULT_BATCH_SIZE);
    private readonly flushIntervalMs = this.readPositiveInt('SHARE_ACCOUNTING_FLUSH_INTERVAL_MS', DEFAULT_FLUSH_INTERVAL_MS);
    private readonly maxQueueSize = this.readPositiveInt('SHARE_ACCOUNTING_MAX_QUEUE_SIZE', DEFAULT_MAX_QUEUE_SIZE);
    private readonly summaryCacheMs = this.readNonNegativeInt('SHARE_ACCOUNTING_SUMMARY_CACHE_MS', DEFAULT_SUMMARY_CACHE_MS);
    private readonly summaryCacheMax = this.readPositiveInt('SHARE_ACCOUNTING_SUMMARY_CACHE_MAX', DEFAULT_SUMMARY_CACHE_MAX);

    constructor(
        @InjectRepository(AcceptedShareEntity)
        private readonly acceptedShareRepository: Repository<AcceptedShareEntity>,
        private readonly redisMessagingService?: RedisMessagingService,
    ) { }

    public async recordAcceptedShare(record: AcceptedShareRecord): Promise<AcceptedShareEntity> {
        const acceptedShare = this.acceptedShareRepository.create({
            ...record,
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
        await this.flushPendingShares();
    }

    public async getPoolSummary(): Promise<ShareAccountingSummary> {
        const cached = await this.redisMessagingService
            ?.getJsonCache<ShareAccountingSummary>(this.poolSummaryCacheKey)
            .catch(error => {
                console.error(`Pool accounting summary cache read failed: ${error.message}`);
                return null;
            });
        if (cached != null) {
            return cached;
        }

        return this.getSummary({});
    }

    public async refreshPoolSummary(): Promise<ShareAccountingSummary> {
        const summary = await this.getSummary({});
        await this.redisMessagingService
            ?.setJsonCache(this.poolSummaryCacheKey, summary, 60 * 1000)
            .catch(error => {
                console.error(`Pool accounting summary cache write failed: ${error.message}`);
            });
        return summary;
    }

    public async getAddressSummary(address: string): Promise<ShareAccountingSummary> {
        return this.getSummary({ address });
    }

    public async getWorkerGroupSummary(address: string, clientName: string): Promise<ShareAccountingSummary> {
        return this.getSummary({ address, clientName });
    }

    public async getSessionSummary(clientId: string): Promise<ShareAccountingSummary> {
        return this.getSummary({ clientId });
    }

    public async getSessionSummaries(clientIds: string[]): Promise<Map<string, SessionShareSummary>> {
        const uniqueClientIds = [...new Set(clientIds.filter(clientId => clientId != null))];
        const summaries = new Map<string, SessionShareSummary>();
        if (uniqueClientIds.length === 0) {
            return summaries;
        }

        const rows = await this.acceptedShareRepository.query(`
            SELECT
                "clientId",
                MAX("acceptedAt") AS "latestShareAt",
                COALESCE((SUM("creditedDifficulty") FILTER (WHERE "acceptedAt" > NOW() - INTERVAL '10 minutes') * ${HASHES_PER_DIFFICULTY}) / 600, 0)::float AS "hashRateLast10Minutes",
                COALESCE(MAX("submissionDifficulty"), 0)::float AS "bestSubmissionDifficulty"
            FROM "accepted_share_entity"
            WHERE "clientId" = ANY($1::uuid[])
            GROUP BY "clientId"
        `, [uniqueClientIds]);

        rows.forEach(row => {
            summaries.set(row.clientId, {
                clientId: row.clientId,
                latestShareAt: row.latestShareAt == null
                    ? null
                    : new Date(row.latestShareAt).toISOString(),
                hashRateLast10Minutes: this.toNumber(row.hashRateLast10Minutes),
                bestSubmissionDifficulty: this.toNumber(row.bestSubmissionDifficulty),
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

        const value = this.loadSummary(filter).catch(error => {
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

    private async loadSummary(filter: AccountingFilter): Promise<ShareAccountingSummary> {
        const { whereSql, params } = this.buildWhereClause(filter);
        const [summary] = await this.acceptedShareRepository.query(`
            SELECT
                COUNT(*)::int AS "totalAcceptedShares",
                COALESCE(SUM("creditedDifficulty"), 0)::float AS "totalCreditedDifficulty",
                COUNT(*) FILTER (WHERE "acceptedAt" > NOW() - INTERVAL '10 minutes')::int AS "acceptedSharesLast10Minutes",
                COALESCE(SUM("creditedDifficulty") FILTER (WHERE "acceptedAt" > NOW() - INTERVAL '10 minutes'), 0)::float AS "creditedDifficultyLast10Minutes",
                COUNT(*) FILTER (WHERE "acceptedAt" > NOW() - INTERVAL '1 hour')::int AS "acceptedSharesLastHour",
                COALESCE(SUM("creditedDifficulty") FILTER (WHERE "acceptedAt" > NOW() - INTERVAL '1 hour'), 0)::float AS "creditedDifficultyLastHour",
                COUNT(*) FILTER (WHERE "acceptedAt" > NOW() - INTERVAL '1 day')::int AS "acceptedSharesLastDay",
                COALESCE(SUM("creditedDifficulty") FILTER (WHERE "acceptedAt" > NOW() - INTERVAL '1 day'), 0)::float AS "creditedDifficultyLastDay",
                COALESCE((SUM("creditedDifficulty") FILTER (WHERE "acceptedAt" > NOW() - INTERVAL '10 minutes') * ${HASHES_PER_DIFFICULTY}) / 600, 0)::float AS "hashRateLast10Minutes",
                COALESCE((SUM("creditedDifficulty") FILTER (WHERE "acceptedAt" > NOW() - INTERVAL '1 hour') * ${HASHES_PER_DIFFICULTY}) / 3600, 0)::float AS "hashRateLastHour",
                COALESCE(MAX("submissionDifficulty"), 0)::float AS "bestSubmissionDifficulty",
                COUNT(*) FILTER (WHERE "isBlockCandidate" = TRUE)::int AS "blockCandidateCount",
                MAX("acceptedAt") AS "latestShareAt"
            FROM "accepted_share_entity"
            ${whereSql}
        `, params);

        const protocolRows = await this.acceptedShareRepository.query(`
            SELECT
                "protocol",
                COUNT(*)::int AS "acceptedShares",
                COALESCE(SUM("creditedDifficulty"), 0)::float AS "creditedDifficulty"
            FROM "accepted_share_entity"
            ${whereSql}
            GROUP BY "protocol"
            ORDER BY "protocol"
        `, params);

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
            bestSubmissionDifficulty: this.toNumber(summary?.bestSubmissionDifficulty),
            blockCandidateCount: this.toNumber(summary?.blockCandidateCount),
            latestShareAt: summary?.latestShareAt == null
                ? null
                : new Date(summary.latestShareAt).toISOString(),
            protocolBreakdown: protocolRows.map(row => ({
                protocol: row.protocol,
                acceptedShares: this.toNumber(row.acceptedShares),
                creditedDifficulty: this.toNumber(row.creditedDifficulty),
            })),
        };
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

        return {
            whereSql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
            params,
        };
    }

    private toNumber(value: unknown): number {
        const parsed = Number(value ?? 0);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    private getSummaryCacheKey(filter: AccountingFilter): string {
        return JSON.stringify({
            address: filter.address ?? null,
            clientName: filter.clientName ?? null,
            clientId: filter.clientId ?? null,
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
