import { MigrationInterface, QueryRunner } from 'typeorm';

export class PoolAccountingDashboardIndexes1780867200000 implements MigrationInterface {
    public name = 'PoolAccountingDashboardIndexes1780867200000';
    public transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_accepted_share_accepted_at"
            ON "accepted_share_entity" ("acceptedAt" DESC)
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_address_settings_best_difficulty"
            ON "address_settings_entity" ("bestDifficulty" DESC)
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_address_settings_best_difficulty"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_accepted_share_accepted_at"`);
    }
}
