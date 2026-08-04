import { MigrationInterface, QueryRunner } from 'typeorm';

export class AcceptedShare10mLookupIndexes1781403000000 implements MigrationInterface {
    public name = 'AcceptedShare10mLookupIndexes1781403000000';
    public transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_accepted_share_10m_bucket"
            ON "accepted_share_10m" ("bucket" DESC)
        `);
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_accepted_share_10m_address_bucket"
            ON "accepted_share_10m" ("address", "bucket" DESC)
        `);
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_accepted_share_10m_address_mode_bucket"
            ON "accepted_share_10m" ("address", "payoutMode", "bucket" DESC)
        `);
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_accepted_share_10m_group_bucket"
            ON "accepted_share_10m" ("address", "clientName", "bucket" DESC)
        `);
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_accepted_share_10m_group_mode_bucket"
            ON "accepted_share_10m" ("address", "clientName", "payoutMode", "bucket" DESC)
        `);
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_accepted_share_10m_client_bucket"
            ON "accepted_share_10m" ("clientId", "bucket" DESC)
        `);
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_accepted_share_10m_client_mode_bucket"
            ON "accepted_share_10m" ("clientId", "payoutMode", "bucket" DESC)
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_accepted_share_10m_client_mode_bucket"`);
        await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_accepted_share_10m_group_mode_bucket"`);
        await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_accepted_share_10m_address_mode_bucket"`);
        await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_accepted_share_10m_client_bucket"`);
        await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_accepted_share_10m_group_bucket"`);
        await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_accepted_share_10m_address_bucket"`);
        await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_accepted_share_10m_bucket"`);
    }
}
