import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { PayoutMode } from '../../types/payout-mode';

type HighScorePayoutMode = PayoutMode | 'all';

interface HighScoreCandidate {
    bucketDate: string;
    bucket: Date;
    blockHeight: string;
    bestSubmissionDifficulty: string;
}

interface ExactHighScore {
    submissionDifficulty: string;
    acceptedAt: Date | null;
    blockHeight: string | null;
    address: string | null;
    clientName: string | null;
    protocol: string | null;
}

interface HighScoreRecord {
    scope: 'all_time' | 'daily';
    payoutMode: HighScorePayoutMode;
    bucketDate: string;
    submissionDifficulty: string;
    acceptedAt: Date | null;
    bucket: Date | null;
    blockHeight: string | null;
    address: string | null;
    clientName: string | null;
    protocol: string | null;
}

export interface HighScoreRefreshResult {
    processed: boolean;
    reason?: 'locked';
    updatedRows: number;
}

const DEFAULT_HIGH_SCORE_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_HIGH_SCORE_LOOKBACK_DAYS = 7;
const HIGH_SCORE_ADVISORY_LOCK = '1781309000';
const ALL_TIME_BUCKET_DATE = '1970-01-01';

@Injectable()
export class ShareHighScoreService implements OnModuleInit, OnModuleDestroy {
    private timer: NodeJS.Timeout | null = null;
    private activeRefresh: Promise<HighScoreRefreshResult> | null = null;
    private readonly refreshIntervalMs = this.readPositiveInt(
        'SHARE_HIGH_SCORE_REFRESH_INTERVAL_MS',
        DEFAULT_HIGH_SCORE_REFRESH_INTERVAL_MS,
    );
    private readonly lookbackDays = this.readPositiveInt(
        'SHARE_HIGH_SCORE_LOOKBACK_DAYS',
        DEFAULT_HIGH_SCORE_LOOKBACK_DAYS,
    );

    constructor(private readonly dataSource: DataSource) { }

    public onModuleInit(): void {
        if (process.env.MASTER !== 'true' || process.env.API_ONLY === 'true') {
            return;
        }

        this.timer = setInterval(() => {
            if (this.activeRefresh != null) {
                return;
            }

            this.activeRefresh = this.refreshHighScores()
                .catch(error => {
                    console.error(`Accepted share high-score refresh failed: ${error.message}`);
                    return { processed: false, updatedRows: 0 };
                })
                .finally(() => {
                    this.activeRefresh = null;
                });
        }, this.refreshIntervalMs);
        this.timer.unref?.();

        setTimeout(() => {
            if (this.activeRefresh == null) {
                this.activeRefresh = this.refreshHighScores()
                    .catch(error => {
                        console.error(`Accepted share high-score refresh failed: ${error.message}`);
                        return { processed: false, updatedRows: 0 };
                    })
                    .finally(() => {
                        this.activeRefresh = null;
                    });
            }
        }, 30_000).unref?.();
    }

    public async onModuleDestroy(): Promise<void> {
        if (this.timer != null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.activeRefresh != null) {
            await this.activeRefresh;
        }
    }

    public async refreshHighScores(): Promise<HighScoreRefreshResult> {
        return this.dataSource.transaction(async manager => {
            const [lockRow] = await manager.query(`
                SELECT pg_try_advisory_xact_lock($1::bigint) AS "locked"
            `, [HIGH_SCORE_ADVISORY_LOCK]);

            if (lockRow?.locked !== true) {
                return { processed: false, reason: 'locked', updatedRows: 0 };
            }

            let updatedRows = 0;
            for (const payoutMode of ['all', 'solo', 'pplns'] as HighScorePayoutMode[]) {
                updatedRows += await this.refreshForPayoutMode(manager, payoutMode);
            }

            return { processed: true, updatedRows };
        });
    }

    private async refreshForPayoutMode(manager: EntityManager, payoutMode: HighScorePayoutMode): Promise<number> {
        const candidates = await this.loadDailyCandidates(manager, payoutMode);
        let updatedRows = 0;

        for (const candidate of candidates) {
            const exact = await this.loadExactHighScore(manager, candidate, payoutMode);
            const record = this.toRecord('daily', payoutMode, candidate.bucketDate, candidate, exact);
            updatedRows += await this.upsertHighScore(manager, record);
            updatedRows += await this.upsertHighScore(manager, {
                ...record,
                scope: 'all_time',
                bucketDate: ALL_TIME_BUCKET_DATE,
            });
        }

        const allTimeRecords = await this.loadAllTimeRecords(manager, payoutMode);
        for (const record of allTimeRecords) {
            updatedRows += await this.upsertHighScore(manager, record);
        }

        return updatedRows;
    }

    private async loadDailyCandidates(manager: EntityManager, payoutMode: HighScorePayoutMode): Promise<HighScoreCandidate[]> {
        const params: unknown[] = [this.lookbackDays];
        const modeFilter = payoutMode === 'all'
            ? ''
            : `AND "payoutMode" = $${params.push(payoutMode)}`;

        return manager.query(`
            WITH candidate_rows AS (
                SELECT
                    date_trunc('day', "bucket")::date AS "bucketDate",
                    "bucket",
                    "blockHeight",
                    "bestSubmissionDifficulty"
                FROM "accepted_share_block_10m"
                WHERE "bucket" >= NOW() - ($1::int * INTERVAL '1 day')
                  AND "bestSubmissionDifficulty" IS NOT NULL
                  AND "bestSubmissionDifficulty" > 0
                  ${modeFilter}
            )
            SELECT DISTINCT ON ("bucketDate")
                "bucketDate"::text AS "bucketDate",
                "bucket",
                "blockHeight"::text AS "blockHeight",
                "bestSubmissionDifficulty"::text AS "bestSubmissionDifficulty"
            FROM candidate_rows
            ORDER BY "bucketDate", "bestSubmissionDifficulty"::numeric DESC, "bucket" DESC
        `, params);
    }

    private async loadAllTimeRecords(manager: EntityManager, payoutMode: HighScorePayoutMode): Promise<HighScoreRecord[]> {
        const records: HighScoreRecord[] = [];
        const rollupCandidate = await this.loadRollupAllTimeCandidate(manager, payoutMode);
        if (rollupCandidate != null) {
            records.push(this.toRecord('all_time', payoutMode, ALL_TIME_BUCKET_DATE, rollupCandidate, null));
        }

        const clientRecord = await this.loadClientAllTimeRecord(manager, payoutMode);
        if (clientRecord != null) {
            records.push(clientRecord);
        }

        if (payoutMode === 'all') {
            const addressRecord = await this.loadAddressSettingsAllTimeRecord(manager);
            if (addressRecord != null) {
                records.push(addressRecord);
            }
        }

        return records;
    }

    private async loadRollupAllTimeCandidate(
        manager: EntityManager,
        payoutMode: HighScorePayoutMode,
    ): Promise<HighScoreCandidate | null> {
        const params: unknown[] = [];
        const modeFilter = payoutMode === 'all'
            ? ''
            : `AND "payoutMode" = $${params.push(payoutMode)}`;
        const rows = await manager.query(`
            SELECT
                date_trunc('day', "bucket")::date::text AS "bucketDate",
                "bucket",
                "blockHeight"::text AS "blockHeight",
                "bestSubmissionDifficulty"::text AS "bestSubmissionDifficulty"
            FROM "accepted_share_block_10m"
            WHERE "bestSubmissionDifficulty" IS NOT NULL
              AND "bestSubmissionDifficulty" > 0
              ${modeFilter}
            ORDER BY "bestSubmissionDifficulty" DESC, "bucket" DESC
            LIMIT 1
        `, params);

        return rows[0] ?? null;
    }

    private async loadClientAllTimeRecord(
        manager: EntityManager,
        payoutMode: HighScorePayoutMode,
    ): Promise<HighScoreRecord | null> {
        const params: unknown[] = [];
        const modeFilter = payoutMode === 'all'
            ? ''
            : `AND "payoutMode" = $${params.push(payoutMode)}`;
        const rows = await manager.query(`
            SELECT
                "bestDifficulty"::text AS "submissionDifficulty",
                "updatedAt" AS "acceptedAt",
                "address",
                "clientName",
                "userAgent" AS "protocol"
            FROM "client_entity"
            WHERE "bestDifficulty" IS NOT NULL
              AND "bestDifficulty" > 0
              ${modeFilter}
            ORDER BY "bestDifficulty" DESC, "updatedAt" DESC
            LIMIT 1
        `, params);
        const row = rows[0];
        if (row == null) {
            return null;
        }

        return {
            scope: 'all_time',
            payoutMode,
            bucketDate: ALL_TIME_BUCKET_DATE,
            submissionDifficulty: row.submissionDifficulty,
            acceptedAt: row.acceptedAt ?? null,
            bucket: null,
            blockHeight: null,
            address: row.address ?? null,
            clientName: row.clientName ?? null,
            protocol: row.protocol ?? null,
        };
    }

    private async loadAddressSettingsAllTimeRecord(manager: EntityManager): Promise<HighScoreRecord | null> {
        const rows = await manager.query(`
            SELECT
                "bestDifficulty"::text AS "submissionDifficulty",
                "updatedAt" AS "acceptedAt",
                "address",
                "bestDifficultyUserAgent" AS "protocol"
            FROM "address_settings_entity"
            WHERE "bestDifficulty" IS NOT NULL
              AND "bestDifficulty" > 0
            ORDER BY "bestDifficulty" DESC, "updatedAt" DESC
            LIMIT 1
        `);
        const row = rows[0];
        if (row == null) {
            return null;
        }

        return {
            scope: 'all_time',
            payoutMode: 'all',
            bucketDate: ALL_TIME_BUCKET_DATE,
            submissionDifficulty: row.submissionDifficulty,
            acceptedAt: row.acceptedAt ?? null,
            bucket: null,
            blockHeight: null,
            address: row.address ?? null,
            clientName: null,
            protocol: row.protocol ?? null,
        };
    }

    private async loadExactHighScore(
        manager: EntityManager,
        candidate: HighScoreCandidate,
        payoutMode: HighScorePayoutMode,
    ): Promise<ExactHighScore | null> {
        const params: unknown[] = [candidate.bucket, candidate.blockHeight];
        const modeFilter = payoutMode === 'all'
            ? ''
            : `AND "payoutMode" = $${params.push(payoutMode)}`;
        const rows = await manager.query(`
            SELECT
                "submissionDifficulty"::text AS "submissionDifficulty",
                "acceptedAt",
                "blockHeight"::text AS "blockHeight",
                "address",
                "clientName",
                "protocol"
            FROM "accepted_share_entity"
            WHERE "acceptedAt" >= $1::timestamptz
              AND "acceptedAt" < $1::timestamptz + INTERVAL '10 minutes'
              AND "blockHeight" = $2::bigint
              ${modeFilter}
            ORDER BY "submissionDifficulty" DESC, "acceptedAt" DESC
            LIMIT 1
        `, params);

        return rows[0] ?? null;
    }

    private toRecord(
        scope: HighScoreRecord['scope'],
        payoutMode: HighScorePayoutMode,
        bucketDate: string,
        candidate: HighScoreCandidate,
        exact: ExactHighScore | null,
    ): HighScoreRecord {
        return {
            scope,
            payoutMode,
            bucketDate,
            submissionDifficulty: exact?.submissionDifficulty ?? candidate.bestSubmissionDifficulty,
            acceptedAt: exact?.acceptedAt ?? candidate.bucket,
            bucket: candidate.bucket,
            blockHeight: exact?.blockHeight ?? candidate.blockHeight,
            address: exact?.address ?? null,
            clientName: exact?.clientName ?? null,
            protocol: exact?.protocol ?? null,
        };
    }

    private async upsertHighScore(manager: EntityManager, record: HighScoreRecord): Promise<number> {
        const rows = await manager.query(`
            INSERT INTO "accepted_share_high_score" (
                "scope",
                "payoutMode",
                "bucketDate",
                "submissionDifficulty",
                "acceptedAt",
                "bucket",
                "blockHeight",
                "address",
                "clientName",
                "protocol"
            ) VALUES (
                $1,
                $2,
                $3::date,
                $4::numeric,
                $5::timestamptz,
                $6::timestamptz,
                $7::bigint,
                $8,
                $9,
                $10
            )
            ON CONFLICT ("scope", "payoutMode", "bucketDate")
            DO UPDATE SET
                "submissionDifficulty" = EXCLUDED."submissionDifficulty",
                "acceptedAt" = EXCLUDED."acceptedAt",
                "bucket" = EXCLUDED."bucket",
                "blockHeight" = EXCLUDED."blockHeight",
                "address" = EXCLUDED."address",
                "clientName" = EXCLUDED."clientName",
                "protocol" = EXCLUDED."protocol",
                "updatedAt" = NOW()
            WHERE EXCLUDED."submissionDifficulty" > "accepted_share_high_score"."submissionDifficulty"
               OR (
                   EXCLUDED."submissionDifficulty" = "accepted_share_high_score"."submissionDifficulty"
                   AND EXCLUDED."acceptedAt" > COALESCE("accepted_share_high_score"."acceptedAt", '-infinity'::timestamptz)
               )
            RETURNING 1
        `, [
            record.scope,
            record.payoutMode,
            record.bucketDate,
            record.submissionDifficulty,
            record.acceptedAt,
            record.bucket,
            record.blockHeight,
            record.address,
            record.clientName,
            record.protocol,
        ]);

        return rows.length;
    }

    private readPositiveInt(name: string, defaultValue: number): number {
        const value = Number(process.env[name]);
        return Number.isInteger(value) && value > 0 ? value : defaultValue;
    }
}
