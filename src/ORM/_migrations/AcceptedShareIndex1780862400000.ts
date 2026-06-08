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
                GREATEST((SELECT COUNT(*) FROM "accepted_share_entity") + 1, 1),
                false
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "accepted_share_entity"
            ALTER COLUMN "shareIndex" SET DEFAULT nextval('accepted_share_index_seq')
        `);
        await queryRunner.query(`
            WITH ordered AS (
                SELECT
                    "id",
                    "acceptedAt",
                    row_number() OVER (ORDER BY "acceptedAt", "id") AS "shareIndex"
                FROM "accepted_share_entity"
                WHERE "shareIndex" IS NULL
            )
            UPDATE "accepted_share_entity" AS share
            SET "shareIndex" = ordered."shareIndex"
            FROM ordered
            WHERE share."id" = ordered."id"
                AND share."acceptedAt" = ordered."acceptedAt"
        `);
        await queryRunner.query(`
            ALTER TABLE "accepted_share_entity"
            ALTER COLUMN "shareIndex" SET NOT NULL
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_accepted_share_order"
            ON "accepted_share_entity" ("shareIndex" DESC)
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
