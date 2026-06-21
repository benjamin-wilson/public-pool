import { MigrationInterface, QueryRunner } from 'typeorm';

export class UserAgentReportNonzeroHashrate1781313000000 implements MigrationInterface {
    public name = 'UserAgentReportNonzeroHashrate1781313000000';
    public transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS "user_agent_report_view"`);
        await queryRunner.query(`
            CREATE MATERIALIZED VIEW "user_agent_report_view" AS
            SELECT
                "userAgent",
                COUNT("userAgent") AS "count",
                MAX("bestDifficulty") AS "bestDifficulty",
                SUM("hashRate") AS "totalHashRate"
            FROM "client_entity"
            WHERE "deletedAt" IS NULL
              AND "hashRate" > 0
            GROUP BY "userAgent"
            ORDER BY "totalHashRate" DESC
        `);
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_client_working_report_updated_user_agent"
            ON "client_entity" ("updatedAt" DESC, "userAgent")
            INCLUDE ("hashRate", "bestDifficulty")
            WHERE "deletedAt" IS NULL
              AND "hashRate" > 0
        `);
        await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_client_active_report_updated_user_agent"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_client_working_report_updated_user_agent"`);
        await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS "user_agent_report_view"`);
        await queryRunner.query(`
            CREATE MATERIALIZED VIEW "user_agent_report_view" AS
            SELECT
                "userAgent",
                COUNT("userAgent") AS "count",
                MAX("bestDifficulty") AS "bestDifficulty",
                SUM("hashRate") AS "totalHashRate"
            FROM "client_entity"
            WHERE "deletedAt" IS NULL
            GROUP BY "userAgent"
            ORDER BY "totalHashRate" DESC
        `);
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_client_active_report_updated_user_agent"
            ON "client_entity" ("updatedAt" DESC, "userAgent")
            INCLUDE ("hashRate", "bestDifficulty")
            WHERE "deletedAt" IS NULL
        `);
    }
}
