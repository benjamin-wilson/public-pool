import { MigrationInterface, QueryRunner } from 'typeorm';

export class CurrentRoundWorkRollup1780899000000 implements MigrationInterface {
    public name = 'CurrentRoundWorkRollup1780899000000';
    public transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE MATERIALIZED VIEW IF NOT EXISTS "accepted_share_block_10m"
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket(INTERVAL '10 minutes', "acceptedAt") AS "bucket",
                "blockHeight",
                SUM("creditedDifficulty") AS "shares",
                COUNT(*) AS "acceptedCount",
                MAX("networkDifficulty") AS "networkDifficulty",
                MAX("submissionDifficulty") AS "bestSubmissionDifficulty"
            FROM "accepted_share_entity"
            GROUP BY "bucket", "blockHeight"
            WITH NO DATA
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
            ON "accepted_share_block_10m" ("blockHeight" DESC, "bucket" DESC)
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_accepted_share_block_10m_height_bucket"`);
        await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS "accepted_share_block_10m"`);
    }
}
