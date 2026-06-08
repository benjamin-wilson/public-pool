import { MigrationInterface, QueryRunner } from 'typeorm';

export class CurrentRoundBestShareIndex1780897600000 implements MigrationInterface {
    public name = 'CurrentRoundBestShareIndex1780897600000';
    public transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_address_settings_best_difficulty"`);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_accepted_share_round_best"
            ON "accepted_share_entity" ("submissionDifficulty" DESC, "acceptedAt" DESC, "blockHeight")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_accepted_share_round_best"`);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_address_settings_best_difficulty"
            ON "address_settings_entity" ("bestDifficulty" DESC)
        `);
    }
}
