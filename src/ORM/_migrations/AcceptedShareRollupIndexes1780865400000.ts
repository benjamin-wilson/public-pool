import { MigrationInterface, QueryRunner } from 'typeorm';

export class AcceptedShareRollupIndexes1780865400000 implements MigrationInterface {
    public name = 'AcceptedShareRollupIndexes1780865400000';
    public transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_accepted_share_10m_bucket"
            ON "accepted_share_10m" ("bucket" DESC)
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_accepted_share_10m_address_bucket"
            ON "accepted_share_10m" ("address", "bucket" DESC)
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_accepted_share_10m_group_bucket"
            ON "accepted_share_10m" ("address", "clientName", "bucket" DESC)
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_accepted_share_10m_client_bucket"
            ON "accepted_share_10m" ("clientId", "bucket" DESC)
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_accepted_share_10m_client_bucket"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_accepted_share_10m_group_bucket"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_accepted_share_10m_address_bucket"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_accepted_share_10m_bucket"`);
    }
}
