import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShareRollupBatches1780962600000 implements MigrationInterface {
    public name = 'ShareRollupBatches1780962600000';
    public transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "share_rollup_batch" (
                "id" bigserial PRIMARY KEY,
                "startShareIndex" bigint NOT NULL,
                "endShareIndex" bigint NOT NULL,
                "startAcceptedAt" timestamptz NOT NULL,
                "endAcceptedAt" timestamptz NOT NULL,
                "acceptedShareCount" bigint NOT NULL,
                "creditedDifficulty" numeric NOT NULL,
                "status" varchar(16) NOT NULL DEFAULT 'finalized',
                "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "finalizedAt" timestamptz,
                CONSTRAINT "CHK_share_rollup_batch_index_order"
                    CHECK ("endShareIndex" >= "startShareIndex")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "IDX_share_rollup_batch_range"
            ON "share_rollup_batch" ("startShareIndex", "endShareIndex")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_share_rollup_batch_finalized_end"
            ON "share_rollup_batch" ("endShareIndex" DESC)
            WHERE "status" = 'finalized'
        `);

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "share_rollup_batch_summary" (
                "batchId" bigint NOT NULL REFERENCES "share_rollup_batch" ("id") ON DELETE CASCADE,
                "address" varchar(62) NOT NULL,
                "clientName" varchar NOT NULL,
                "protocol" varchar(8) NOT NULL,
                "blockHeight" integer NOT NULL,
                "creditedDifficulty" numeric NOT NULL,
                "acceptedShareCount" bigint NOT NULL,
                "bestSubmissionDifficulty" numeric NOT NULL,
                "firstShareAt" timestamptz NOT NULL,
                "lastShareAt" timestamptz NOT NULL,
                PRIMARY KEY ("batchId", "address", "clientName", "protocol", "blockHeight")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_share_rollup_summary_address_batch"
            ON "share_rollup_batch_summary" ("address", "clientName", "blockHeight", "batchId")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_share_rollup_summary_address_batch"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "share_rollup_batch_summary"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_share_rollup_batch_finalized_end"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_share_rollup_batch_range"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "share_rollup_batch"`);
    }
}
