import { MigrationInterface, QueryRunner } from 'typeorm';

export class ActiveClientReportRecentIndex1781312000000 implements MigrationInterface {
    public name = 'ActiveClientReportRecentIndex1781312000000';
    public transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_client_active_report_updated_user_agent"
            ON "client_entity" ("updatedAt" DESC, "userAgent")
            INCLUDE ("hashRate", "bestDifficulty")
            WHERE "deletedAt" IS NULL
        `);
        await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_client_working_report_updated_user_agent"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_client_working_report_updated_user_agent"
            ON "client_entity" ("updatedAt" DESC, "userAgent")
            INCLUDE ("hashRate", "bestDifficulty")
            WHERE "deletedAt" IS NULL
              AND "hashRate" > 0
        `);
        await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_client_active_report_updated_user_agent"`);
    }
}
