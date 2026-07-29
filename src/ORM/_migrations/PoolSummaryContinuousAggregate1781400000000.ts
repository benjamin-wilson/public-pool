import { MigrationInterface, QueryRunner } from 'typeorm';

export class PoolSummaryContinuousAggregate1781400000000 implements MigrationInterface {
    public name = 'PoolSummaryContinuousAggregate1781400000000';
    public transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE MATERIALIZED VIEW IF NOT EXISTS "accepted_share_pool_10m"
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket(INTERVAL '10 minutes', "acceptedAt") AS "bucket",
                "payoutMode",
                SUM("creditedDifficulty") AS "shares",
                COUNT(*) AS "acceptedCount"
            FROM "accepted_share_entity"
            GROUP BY "bucket", "payoutMode"
            WITH NO DATA
        `);
        await queryRunner.query(`
            SELECT add_continuous_aggregate_policy(
                'accepted_share_pool_10m',
                start_offset => INTERVAL '25 hours',
                end_offset => INTERVAL '1 minute',
                schedule_interval => INTERVAL '1 minute',
                if_not_exists => TRUE
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_accepted_share_pool_10m_bucket"
            ON "accepted_share_pool_10m" ("bucket" DESC)
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_accepted_share_pool_10m_mode_bucket"
            ON "accepted_share_pool_10m" ("payoutMode", "bucket" DESC)
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_accepted_share_pool_10m_mode_bucket"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_accepted_share_pool_10m_bucket"`);
        await queryRunner.query(`
            SELECT remove_continuous_aggregate_policy(
                'accepted_share_pool_10m',
                if_exists => TRUE
            )
        `);
        await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS "accepted_share_pool_10m"`);
    }
}
