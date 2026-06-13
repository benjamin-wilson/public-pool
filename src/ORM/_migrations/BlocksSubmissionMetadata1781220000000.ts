import { MigrationInterface, QueryRunner } from 'typeorm';

export class BlocksSubmissionMetadata1781220000000 implements MigrationInterface {
    public name = 'BlocksSubmissionMetadata1781220000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "blocks_entity" ADD COLUMN IF NOT EXISTS "blockHash" varchar`);
        await queryRunner.query(`ALTER TABLE "blocks_entity" ADD COLUMN IF NOT EXISTS "blockSubmissionResult" varchar`);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_blocks_successful_found"
            ON "blocks_entity" ("height" DESC, "createdAt" DESC)
            WHERE "blockSubmissionResult" IS NULL OR "blockSubmissionResult" = 'SUCCESS!'
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "UQ_blocks_block_hash"
            ON "blocks_entity" ("blockHash")
            WHERE "blockHash" IS NOT NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "UQ_blocks_block_hash"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_blocks_successful_found"`);
        await queryRunner.query(`ALTER TABLE "blocks_entity" DROP COLUMN IF EXISTS "blockSubmissionResult"`);
        await queryRunner.query(`ALTER TABLE "blocks_entity" DROP COLUMN IF EXISTS "blockHash"`);
    }
}
