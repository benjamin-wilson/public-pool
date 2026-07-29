import { MigrationInterface, QueryRunner } from 'typeorm';

export class AcceptedShareHighScoreNumericRetention1781402000000 implements MigrationInterface {
    public name = 'AcceptedShareHighScoreNumericRetention1781402000000';
    public transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_accepted_share_block_10m_best"
            ON "accepted_share_block_10m" ("bestSubmissionDifficulty" DESC, "bucket" DESC)
            WHERE "bestSubmissionDifficulty" > 0
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_accepted_share_block_10m_mode_best"
            ON "accepted_share_block_10m" ("payoutMode", "bestSubmissionDifficulty" DESC, "bucket" DESC)
            WHERE "bestSubmissionDifficulty" > 0
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_client_best_difficulty_mode"
            ON "client_entity" ("payoutMode", "bestDifficulty" DESC, "updatedAt" DESC)
            WHERE "bestDifficulty" > 0
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_address_settings_best_difficulty"
            ON "address_settings_entity" ("bestDifficulty" DESC, "updatedAt" DESC)
            WHERE "bestDifficulty" > 0
        `);

        await this.backfillRollupAllTime(queryRunner);
        await this.backfillClientAllTime(queryRunner);
        await this.backfillAddressSettingsAllTime(queryRunner);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_address_settings_best_difficulty"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_client_best_difficulty_mode"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_accepted_share_block_10m_mode_best"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_accepted_share_block_10m_best"`);
    }

    private async backfillRollupAllTime(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            WITH candidates AS (
                SELECT
                    "payoutMode",
                    "bucket",
                    "blockHeight",
                    "bestSubmissionDifficulty"
                FROM "accepted_share_block_10m"
                WHERE "bestSubmissionDifficulty" IS NOT NULL
                  AND "bestSubmissionDifficulty" > 0

                UNION ALL

                SELECT
                    'all' AS "payoutMode",
                    "bucket",
                    "blockHeight",
                    "bestSubmissionDifficulty"
                FROM "accepted_share_block_10m"
                WHERE "bestSubmissionDifficulty" IS NOT NULL
                  AND "bestSubmissionDifficulty" > 0
            ),
            best_rows AS (
                SELECT DISTINCT ON ("payoutMode")
                    "payoutMode",
                    "bucket",
                    "blockHeight",
                    "bestSubmissionDifficulty"
                FROM candidates
                ORDER BY "payoutMode", "bestSubmissionDifficulty" DESC, "bucket" DESC
            )
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
            )
            SELECT
                'all_time',
                "payoutMode",
                DATE '1970-01-01',
                "bestSubmissionDifficulty",
                "bucket",
                "bucket",
                "blockHeight",
                NULL,
                NULL,
                NULL
            FROM best_rows
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
        `);
    }

    private async backfillClientAllTime(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            WITH candidates AS (
                SELECT
                    "payoutMode",
                    "bestDifficulty",
                    "updatedAt",
                    "address",
                    "clientName",
                    "userAgent"
                FROM "client_entity"
                WHERE "bestDifficulty" IS NOT NULL
                  AND "bestDifficulty" > 0

                UNION ALL

                SELECT
                    'all' AS "payoutMode",
                    "bestDifficulty",
                    "updatedAt",
                    "address",
                    "clientName",
                    "userAgent"
                FROM "client_entity"
                WHERE "bestDifficulty" IS NOT NULL
                  AND "bestDifficulty" > 0
            ),
            best_rows AS (
                SELECT DISTINCT ON ("payoutMode")
                    "payoutMode",
                    "bestDifficulty",
                    "updatedAt",
                    "address",
                    "clientName",
                    "userAgent"
                FROM candidates
                ORDER BY "payoutMode", "bestDifficulty" DESC, "updatedAt" DESC
            )
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
            )
            SELECT
                'all_time',
                "payoutMode",
                DATE '1970-01-01',
                "bestDifficulty",
                "updatedAt",
                NULL,
                NULL,
                "address",
                "clientName",
                "userAgent"
            FROM best_rows
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
        `);
    }

    private async backfillAddressSettingsAllTime(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            WITH best_row AS (
                SELECT
                    "bestDifficulty",
                    "updatedAt",
                    "address",
                    "bestDifficultyUserAgent"
                FROM "address_settings_entity"
                WHERE "bestDifficulty" IS NOT NULL
                  AND "bestDifficulty" > 0
                ORDER BY "bestDifficulty" DESC, "updatedAt" DESC
                LIMIT 1
            )
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
            )
            SELECT
                'all_time',
                'all',
                DATE '1970-01-01',
                "bestDifficulty",
                "updatedAt",
                NULL,
                NULL,
                "address",
                NULL,
                "bestDifficultyUserAgent"
            FROM best_row
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
        `);
    }
}
