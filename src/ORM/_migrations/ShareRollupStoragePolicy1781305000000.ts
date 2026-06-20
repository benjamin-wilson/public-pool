import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShareRollupStoragePolicy1781305000000 implements MigrationInterface {
    public name = 'ShareRollupStoragePolicy1781305000000';
    public transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`TRUNCATE TABLE "payout_balance", "share_rollup_batch" RESTART IDENTITY CASCADE`);

        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_share_rollup_summary_address_batch"`);
        await queryRunner.query(`ALTER TABLE "share_rollup_batch_summary" DROP CONSTRAINT IF EXISTS "share_rollup_batch_summary_pkey"`);

        await queryRunner.query(`
            SELECT create_hypertable(
                '"share_rollup_batch_summary"',
                'lastShareAt',
                chunk_time_interval => INTERVAL '1 day',
                if_not_exists => TRUE,
                migrate_data => FALSE
            )
        `);

        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_share_rollup_summary_batch"
            ON "share_rollup_batch_summary" ("batchId", "payoutMode")
        `);

        await queryRunner.query(`
            ALTER TABLE "share_rollup_batch_summary" SET (
                timescaledb.compress,
                timescaledb.compress_orderby = '"lastShareAt" DESC',
                timescaledb.compress_segmentby = '"payoutMode","batchId"'
            )
        `);
        await queryRunner.query(`SELECT remove_compression_policy('share_rollup_batch_summary', if_exists => TRUE)`);
        await queryRunner.query(`
            SELECT add_compression_policy(
                'share_rollup_batch_summary',
                INTERVAL '24 hours',
                if_not_exists => TRUE
            )
        `);

        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_accepted_share_accounting_lookup"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_accepted_share_client_lookup"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_accepted_share_order"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_accepted_share_accepted_at"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_accepted_share_round_best"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_accepted_share_protocol_work"`);

        await queryRunner.query(`
            CREATE OR REPLACE PROCEDURE prune_share_rollup_batches(job_id int, config jsonb)
            LANGUAGE PLPGSQL
            AS $$
            DECLARE
                retention interval := COALESCE((config ->> 'retention')::interval, INTERVAL '30 days');
                deleted_count bigint;
            BEGIN
                DELETE FROM "share_rollup_batch"
                WHERE "status" = 'finalized'
                  AND "finalizedAt" IS NOT NULL
                  AND "finalizedAt" < NOW() - retention;

                GET DIAGNOSTICS deleted_count = ROW_COUNT;
                RAISE LOG 'prune_share_rollup_batches deleted % finalized batches older than %', deleted_count, retention;
            END;
            $$
        `);

        await queryRunner.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1
                    FROM timescaledb_information.jobs
                    WHERE proc_name = 'prune_share_rollup_batches'
                ) THEN
                    PERFORM add_job(
                        'prune_share_rollup_batches'::regproc,
                        INTERVAL '1 day',
                        jsonb_build_object('retention', '30 days')
                    );
                END IF;
            END;
            $$
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`SELECT delete_job(job_id) FROM timescaledb_information.jobs WHERE proc_name = 'prune_share_rollup_batches'`);
        await queryRunner.query(`DROP PROCEDURE IF EXISTS prune_share_rollup_batches(int, jsonb)`);
        await queryRunner.query(`SELECT remove_compression_policy('share_rollup_batch_summary', if_exists => TRUE)`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_share_rollup_summary_batch"`);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_share_rollup_summary_address_batch"
            ON "share_rollup_batch_summary" ("payoutMode", "address", "clientName", "blockHeight", "batchId")
        `);

        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_accepted_share_accounting_lookup"
            ON "accepted_share_entity" ("payoutMode", "address", "clientName", "acceptedAt" DESC)
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_accepted_share_client_lookup"
            ON "accepted_share_entity" ("clientId", "acceptedAt" DESC)
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_accepted_share_order"
            ON "accepted_share_entity" ("shareIndex" DESC)
            WHERE "shareIndex" IS NOT NULL
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_accepted_share_accepted_at"
            ON "accepted_share_entity" ("acceptedAt" DESC)
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_accepted_share_round_best"
            ON "accepted_share_entity" ("submissionDifficulty" DESC, "acceptedAt" DESC, "blockHeight")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_accepted_share_protocol_work"
            ON "accepted_share_entity" ("protocol", "workSource", "workProtocol", "acceptedAt" DESC)
        `);
    }
}
