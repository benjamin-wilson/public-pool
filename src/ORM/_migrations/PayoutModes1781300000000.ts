import { MigrationInterface, QueryRunner } from 'typeorm';

export class PayoutModes1781300000000 implements MigrationInterface {
    public name = 'PayoutModes1781300000000';
    public transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "accepted_share_entity" ADD COLUMN IF NOT EXISTS "payoutMode" varchar(16) NOT NULL DEFAULT 'solo'`);
        await queryRunner.query(`ALTER TABLE "client_entity" ADD COLUMN IF NOT EXISTS "payoutMode" varchar(16) NOT NULL DEFAULT 'solo'`);
        await queryRunner.query(`ALTER TABLE "blocks_entity" ADD COLUMN IF NOT EXISTS "payoutMode" varchar(16) NOT NULL DEFAULT 'solo'`);
        await queryRunner.query(`ALTER TABLE "share_rollup_batch" ADD COLUMN IF NOT EXISTS "payoutMode" varchar(16) NOT NULL DEFAULT 'pplns'`);
        await queryRunner.query(`ALTER TABLE "share_rollup_batch_summary" ADD COLUMN IF NOT EXISTS "payoutMode" varchar(16) NOT NULL DEFAULT 'pplns'`);
        await queryRunner.query(`ALTER TABLE "payout_snapshot" ADD COLUMN IF NOT EXISTS "payoutMode" varchar(16) NOT NULL DEFAULT 'pplns'`);
        await queryRunner.query(`ALTER TABLE "payout_snapshot_entry" ADD COLUMN IF NOT EXISTS "payoutMode" varchar(16) NOT NULL DEFAULT 'pplns'`);
        await queryRunner.query(`ALTER TABLE "payout_history" ADD COLUMN IF NOT EXISTS "payoutMode" varchar(16) NOT NULL DEFAULT 'pplns'`);

        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_accepted_share_accounting_lookup"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_accepted_share_unique_submission"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_share_rollup_batch_range"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_share_rollup_batch_finalized_end"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_share_rollup_summary_address_batch"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payout_snapshot_latest"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payout_snapshot_template_window"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "UQ_payout_history_block_address"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payout_history_address_created"`);

        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_accepted_share_accounting_lookup"
            ON "accepted_share_entity" ("payoutMode", "address", "clientName", "acceptedAt" DESC)
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_accepted_share_mode_order"
            ON "accepted_share_entity" ("payoutMode", "shareIndex")
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "IDX_accepted_share_unique_submission"
            ON "accepted_share_entity" ("acceptedAt", "payoutMode", "protocol", "sessionId", "jobId", "nonce", "ntime", "version", "extraNonce2")
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "IDX_share_rollup_batch_range"
            ON "share_rollup_batch" ("payoutMode", "startShareIndex", "endShareIndex")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_share_rollup_batch_finalized_end"
            ON "share_rollup_batch" ("payoutMode", "endShareIndex" DESC)
            WHERE "status" = 'finalized'
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_share_rollup_summary_address_batch"
            ON "share_rollup_batch_summary" ("payoutMode", "address", "clientName", "blockHeight", "batchId")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_payout_snapshot_latest"
            ON "payout_snapshot" ("payoutMode", "status", "createdAt" DESC, "id" DESC)
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "IDX_payout_snapshot_template_window"
            ON "payout_snapshot" ("payoutMode", "method", "blockHeight", "coinbaseValueSats", "windowEndShareIndex")
            WHERE "status" = 'finalized'
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "UQ_payout_history_block_address"
            ON "payout_history" ("payoutMode", "blockHeight", "address")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_payout_history_address_created"
            ON "payout_history" ("payoutMode", "address", "createdAt" DESC)
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_blocks_payout_mode_height"
            ON "blocks_entity" ("payoutMode", "height" DESC, "createdAt" DESC)
        `);

        await this.recreateContinuousAggregates(queryRunner);

        await queryRunner.query(`
            ALTER TABLE "accepted_share_entity"
            SET (
                timescaledb.compress_segmentby = '"payoutMode","address","clientName"',
                timescaledb.compress_orderby = '"acceptedAt" DESC'
            )
        `).catch(() => undefined);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_blocks_payout_mode_height"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_accepted_share_mode_order"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_accepted_share_accounting_lookup"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_accepted_share_unique_submission"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_share_rollup_batch_range"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_share_rollup_batch_finalized_end"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_share_rollup_summary_address_batch"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payout_snapshot_latest"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payout_snapshot_template_window"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "UQ_payout_history_block_address"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payout_history_address_created"`);

        await queryRunner.query(`ALTER TABLE "payout_history" DROP COLUMN IF EXISTS "payoutMode"`);
        await queryRunner.query(`ALTER TABLE "payout_snapshot_entry" DROP COLUMN IF EXISTS "payoutMode"`);
        await queryRunner.query(`ALTER TABLE "payout_snapshot" DROP COLUMN IF EXISTS "payoutMode"`);
        await queryRunner.query(`ALTER TABLE "share_rollup_batch_summary" DROP COLUMN IF EXISTS "payoutMode"`);
        await queryRunner.query(`ALTER TABLE "share_rollup_batch" DROP COLUMN IF EXISTS "payoutMode"`);
        await queryRunner.query(`ALTER TABLE "blocks_entity" DROP COLUMN IF EXISTS "payoutMode"`);
        await queryRunner.query(`ALTER TABLE "client_entity" DROP COLUMN IF EXISTS "payoutMode"`);
        await queryRunner.query(`ALTER TABLE "accepted_share_entity" DROP COLUMN IF EXISTS "payoutMode"`);
    }

    private async recreateContinuousAggregates(queryRunner: QueryRunner): Promise<void> {
        await this.dropContinuousAggregate(queryRunner, 'accepted_share_block_10m');
        await this.dropContinuousAggregate(queryRunner, 'accepted_share_1d');
        await this.dropContinuousAggregate(queryRunner, 'accepted_share_1h');
        await this.dropContinuousAggregate(queryRunner, 'accepted_share_10m');

        await queryRunner.query(`
            CREATE MATERIALIZED VIEW IF NOT EXISTS "accepted_share_10m"
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket(INTERVAL '10 minutes', "acceptedAt") AS "bucket",
                "payoutMode",
                "address",
                "clientName",
                "sessionId",
                "clientId",
                SUM("creditedDifficulty") AS "shares",
                COUNT(*) AS "acceptedCount",
                ROUND(((SUM("creditedDifficulty") * 4294967296) / 600)) AS "hashRate"
            FROM "accepted_share_entity"
            GROUP BY "bucket", "payoutMode", "address", "clientName", "sessionId", "clientId"
            WITH NO DATA
        `);
        await queryRunner.query(`
            CREATE MATERIALIZED VIEW IF NOT EXISTS "accepted_share_1h"
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket(INTERVAL '1 hour', "acceptedAt") AS "bucket",
                "payoutMode",
                "address",
                "clientName",
                SUM("creditedDifficulty") AS "shares",
                COUNT(*) AS "acceptedCount"
            FROM "accepted_share_entity"
            GROUP BY "bucket", "payoutMode", "address", "clientName"
            WITH NO DATA
        `);
        await queryRunner.query(`
            CREATE MATERIALIZED VIEW IF NOT EXISTS "accepted_share_1d"
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket(INTERVAL '1 day', "acceptedAt") AS "bucket",
                "payoutMode",
                "address",
                SUM("creditedDifficulty") AS "shares",
                COUNT(*) AS "acceptedCount"
            FROM "accepted_share_entity"
            GROUP BY "bucket", "payoutMode", "address"
            WITH NO DATA
        `);
        await queryRunner.query(`
            CREATE MATERIALIZED VIEW IF NOT EXISTS "accepted_share_block_10m"
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket(INTERVAL '10 minutes', "acceptedAt") AS "bucket",
                "payoutMode",
                "blockHeight",
                SUM("creditedDifficulty") AS "shares",
                COUNT(*) AS "acceptedCount",
                MAX("networkDifficulty") AS "networkDifficulty",
                MAX("submissionDifficulty") AS "bestSubmissionDifficulty"
            FROM "accepted_share_entity"
            GROUP BY "bucket", "payoutMode", "blockHeight"
            WITH NO DATA
        `);

        await queryRunner.query(`
            SELECT add_continuous_aggregate_policy(
                'accepted_share_10m',
                start_offset => INTERVAL '2 days',
                end_offset => INTERVAL '1 minute',
                schedule_interval => INTERVAL '1 minute',
                if_not_exists => TRUE
            )
        `);
        await queryRunner.query(`
            SELECT add_continuous_aggregate_policy(
                'accepted_share_1h',
                start_offset => INTERVAL '30 days',
                end_offset => INTERVAL '10 minutes',
                schedule_interval => INTERVAL '10 minutes',
                if_not_exists => TRUE
            )
        `);
        await queryRunner.query(`
            SELECT add_continuous_aggregate_policy(
                'accepted_share_1d',
                start_offset => INTERVAL '365 days',
                end_offset => INTERVAL '1 hour',
                schedule_interval => INTERVAL '1 hour',
                if_not_exists => TRUE
            )
        `);
        await queryRunner.query(`
            SELECT add_continuous_aggregate_policy(
                'accepted_share_block_10m',
                start_offset => INTERVAL '180 days',
                end_offset => INTERVAL '1 minute',
                schedule_interval => INTERVAL '1 minute',
                if_not_exists => TRUE
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_accepted_share_block_10m_height_bucket"
            ON "accepted_share_block_10m" ("payoutMode", "blockHeight" DESC, "bucket" DESC)
        `);
    }

    private async dropContinuousAggregate(queryRunner: QueryRunner, viewName: string): Promise<void> {
        await queryRunner.query(`SELECT remove_continuous_aggregate_policy('${viewName}', if_exists => TRUE)`).catch(() => undefined);
        await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS "${viewName}" CASCADE`);
    }
}
