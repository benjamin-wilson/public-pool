import { MigrationInterface, QueryRunner } from 'typeorm';

export class AcceptedShareIndex1780862400000 implements MigrationInterface {
    public name = 'AcceptedShareIndex1780862400000';
    public transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE SEQUENCE IF NOT EXISTS "accepted_share_index_seq"`);
        await queryRunner.query(`ALTER TABLE "accepted_share_entity" ADD COLUMN IF NOT EXISTS "shareIndex" bigint`);
        await queryRunner.query(`
            SELECT setval(
                'accepted_share_index_seq',
                GREATEST(
                    (SELECT COUNT(*) FROM "accepted_share_entity") + 1,
                    (SELECT COALESCE(MAX("shareIndex"), 0) + 1 FROM "accepted_share_entity"),
                    1
                ),
                false
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "accepted_share_entity"
            ALTER COLUMN "shareIndex" SET DEFAULT nextval('accepted_share_index_seq')
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_accepted_share_order"
            ON "accepted_share_entity" ("shareIndex" DESC)
            WHERE "shareIndex" IS NOT NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_accepted_share_order"`);
        await queryRunner.query(`
            ALTER TABLE "accepted_share_entity"
            ALTER COLUMN "shareIndex" DROP DEFAULT
        `);
        await queryRunner.query(`ALTER TABLE "accepted_share_entity" DROP COLUMN IF EXISTS "shareIndex"`);
        await queryRunner.query(`DROP SEQUENCE IF EXISTS "accepted_share_index_seq"`);
    }
}
