import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialTimescaleSchema1780859300000 implements MigrationInterface {
    public name = 'InitialTimescaleSchema1780859300000';
    public transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS timescaledb`);

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "address_settings_entity" (
                "address" varchar(62) PRIMARY KEY,
                "shares" integer NOT NULL DEFAULT 0,
                "bestDifficulty" numeric NOT NULL DEFAULT 0,
                "bestDifficultyUserAgent" varchar,
                "miscCoinbaseScriptData" varchar,
                "deletedAt" timestamptz,
                "createdAt" timestamptz NOT NULL DEFAULT now(),
                "updatedAt" timestamptz NOT NULL DEFAULT now()
            )
        `);

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "client_entity" (
                "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
                "address" varchar(62) NOT NULL,
                "clientName" varchar(64) NOT NULL,
                "sessionId" varchar(8) NOT NULL,
                "userAgent" varchar(128),
                "startTime" timestamptz NOT NULL,
                "bestDifficulty" numeric NOT NULL DEFAULT 0,
                "hashRate" numeric NOT NULL DEFAULT 0,
                "deletedAt" timestamptz,
                "createdAt" timestamptz NOT NULL DEFAULT now(),
                "updatedAt" timestamptz NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_client_entity_address" ON "client_entity" ("address")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_client_cleanup" ON "client_entity" ("id") WHERE "deletedAt" IS NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_unique_nonce" ON "client_entity" ("sessionId") WHERE "deletedAt" IS NOT NULL`);

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "accepted_share_entity" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "acceptedAt" timestamptz NOT NULL,
                "protocol" varchar(8) NOT NULL,
                "address" varchar(62) NOT NULL,
                "clientName" varchar NOT NULL,
                "sessionId" varchar(8) NOT NULL,
                "clientId" uuid NOT NULL,
                "jobId" varchar NOT NULL,
                "jobTemplateId" varchar NOT NULL,
                "blockHeight" bigint NOT NULL,
                "creditedDifficulty" numeric NOT NULL,
                "submissionDifficulty" numeric NOT NULL,
                "networkDifficulty" numeric NOT NULL,
                "nonce" varchar NOT NULL,
                "ntime" varchar NOT NULL,
                "version" varchar NOT NULL,
                "extraNonce2" varchar NOT NULL,
                "isBlockCandidate" boolean NOT NULL DEFAULT false,
                "blockSubmissionResult" text,
                "createdAt" timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY ("id", "acceptedAt")
            )
        `);
        await queryRunner.query(`
            SELECT create_hypertable(
                '"accepted_share_entity"',
                'acceptedAt',
                chunk_time_interval => INTERVAL '1 day',
                if_not_exists => TRUE
            )
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_accepted_share_accounting_lookup" ON "accepted_share_entity" ("address", "clientName", "acceptedAt" DESC)`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_accepted_share_client_lookup" ON "accepted_share_entity" ("clientId", "acceptedAt" DESC)`);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "IDX_accepted_share_unique_submission"
            ON "accepted_share_entity" ("acceptedAt", "protocol", "sessionId", "jobId", "nonce", "ntime", "version", "extraNonce2")
        `);

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "blocks_entity" (
                "id" bigserial PRIMARY KEY,
                "height" integer NOT NULL,
                "minerAddress" varchar(62) NOT NULL,
                "worker" varchar NOT NULL,
                "sessionId" varchar(8) NOT NULL,
                "blockData" varchar NOT NULL,
                "deletedAt" timestamptz,
                "createdAt" timestamptz NOT NULL DEFAULT now(),
                "updatedAt" timestamptz NOT NULL DEFAULT now()
            )
        `);

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "rpc_block_entity" (
                "blockHeight" integer PRIMARY KEY,
                "data" varchar
            )
        `);

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "telegram_subscriptions_entity" (
                "id" bigserial PRIMARY KEY,
                "address" varchar(62) NOT NULL,
                "telegramChatId" integer NOT NULL,
                "deletedAt" timestamptz,
                "createdAt" timestamptz NOT NULL DEFAULT now(),
                "updatedAt" timestamptz NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_telegram_subscriptions_address" ON "telegram_subscriptions_entity" ("address")`);

        await queryRunner.query(`
            CREATE MATERIALIZED VIEW IF NOT EXISTS "user_agent_report_view" AS
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
            CREATE MATERIALIZED VIEW IF NOT EXISTS "accepted_share_10m"
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket(INTERVAL '10 minutes', "acceptedAt") AS "bucket",
                "address",
                "clientName",
                "sessionId",
                "clientId",
                SUM("creditedDifficulty") AS "shares",
                COUNT(*) AS "acceptedCount",
                ROUND(((SUM("creditedDifficulty") * 4294967296) / 600)) AS "hashRate"
            FROM "accepted_share_entity"
            GROUP BY "bucket", "address", "clientName", "sessionId", "clientId"
            WITH NO DATA
        `);

        await queryRunner.query(`
            CREATE MATERIALIZED VIEW IF NOT EXISTS "accepted_share_1h"
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket(INTERVAL '1 hour', "acceptedAt") AS "bucket",
                "address",
                "clientName",
                SUM("creditedDifficulty") AS "shares",
                COUNT(*) AS "acceptedCount"
            FROM "accepted_share_entity"
            GROUP BY "bucket", "address", "clientName"
            WITH NO DATA
        `);

        await queryRunner.query(`
            CREATE MATERIALIZED VIEW IF NOT EXISTS "accepted_share_1d"
            WITH (timescaledb.continuous) AS
            SELECT
                time_bucket(INTERVAL '1 day', "acceptedAt") AS "bucket",
                "address",
                SUM("creditedDifficulty") AS "shares",
                COUNT(*) AS "acceptedCount"
            FROM "accepted_share_entity"
            GROUP BY "bucket", "address"
            WITH NO DATA
        `);

        await queryRunner.query(`
            SELECT add_continuous_aggregate_policy(
                'accepted_share_10m',
                start_offset => INTERVAL '2 days',
                end_offset => INTERVAL '1 minute',
                schedule_interval => INTERVAL '1 minute',
                if_not_exists => TRUE
            )
        `);
        await queryRunner.query(`
            SELECT add_continuous_aggregate_policy(
                'accepted_share_1h',
                start_offset => INTERVAL '30 days',
                end_offset => INTERVAL '10 minutes',
                schedule_interval => INTERVAL '10 minutes',
                if_not_exists => TRUE
            )
        `);
        await queryRunner.query(`
            SELECT add_continuous_aggregate_policy(
                'accepted_share_1d',
                start_offset => INTERVAL '365 days',
                end_offset => INTERVAL '1 hour',
                schedule_interval => INTERVAL '1 hour',
                if_not_exists => TRUE
            )
        `);
        await queryRunner.query(`SELECT add_retention_policy('accepted_share_entity', INTERVAL '90 days', if_not_exists => TRUE)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS "accepted_share_1d"`);
        await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS "accepted_share_1h"`);
        await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS "accepted_share_10m"`);
        await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS "user_agent_report_view"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "accepted_share_entity" CASCADE`);
        await queryRunner.query(`DROP TABLE IF EXISTS "telegram_subscriptions_entity"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "rpc_block_entity"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "blocks_entity"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "client_entity"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "address_settings_entity"`);
    }
}
