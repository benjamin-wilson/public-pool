import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixClientSessionActiveIndex1780863600000 implements MigrationInterface {
    public name = 'FixClientSessionActiveIndex1780863600000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_unique_nonce"`);
        await queryRunner.query(`
            DELETE FROM "client_entity"
            WHERE ctid IN (
                SELECT ctid
                FROM (
                    SELECT
                        ctid,
                        row_number() OVER (
                            PARTITION BY "sessionId"
                            ORDER BY "createdAt" DESC, "id" DESC
                        ) AS rn
                    FROM "client_entity"
                    WHERE "deletedAt" IS NULL
                ) duplicates
                WHERE rn > 1
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "IDX_unique_nonce"
            ON "client_entity" ("sessionId")
            WHERE "deletedAt" IS NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_unique_nonce"`);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "IDX_unique_nonce"
            ON "client_entity" ("sessionId")
            WHERE "deletedAt" IS NOT NULL
        `);
    }
}
