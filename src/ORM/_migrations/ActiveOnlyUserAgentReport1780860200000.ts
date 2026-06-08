import { MigrationInterface, QueryRunner } from 'typeorm';

export class ActiveOnlyUserAgentReport1780860200000 implements MigrationInterface {
    name = 'ActiveOnlyUserAgentReport1780860200000';

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
            GROUP BY "userAgent"
            ORDER BY "totalHashRate" DESC
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS "user_agent_report_view"`);
        await queryRunner.query(`
            CREATE MATERIALIZED VIEW "user_agent_report_view" AS
            SELECT
                "userAgent",
                COUNT("userAgent") AS "count",
                MAX("bestDifficulty") AS "bestDifficulty",
                SUM("hashRate") AS "totalHashRate"
            FROM "client_entity"
            GROUP BY "userAgent"
            ORDER BY "totalHashRate" DESC
        `);
    }
}
