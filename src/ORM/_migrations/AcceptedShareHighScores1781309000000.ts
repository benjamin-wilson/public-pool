import { MigrationInterface, QueryRunner } from 'typeorm';

export class AcceptedShareHighScores1781309000000 implements MigrationInterface {
    public name = 'AcceptedShareHighScores1781309000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "accepted_share_high_score" (
                "id" bigserial PRIMARY KEY,
                "scope" varchar(16) NOT NULL,
                "payoutMode" varchar(16) NOT NULL DEFAULT 'all',
                "bucketDate" date NOT NULL DEFAULT DATE '1970-01-01',
                "submissionDifficulty" numeric NOT NULL DEFAULT 0,
                "acceptedAt" timestamptz,
                "bucket" timestamptz,
                "blockHeight" bigint,
                "address" varchar(128),
                "clientName" varchar(256),
                "protocol" varchar(16),
                "createdAt" timestamptz NOT NULL DEFAULT NOW(),
                "updatedAt" timestamptz NOT NULL DEFAULT NOW()
            )
        `);

        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "UQ_accepted_share_high_score_scope"
            ON "accepted_share_high_score" ("scope", "payoutMode", "bucketDate")
        `);

        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_accepted_share_high_score_best"
            ON "accepted_share_high_score" ("payoutMode", "submissionDifficulty" DESC, "acceptedAt" DESC)
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "accepted_share_high_score"`);
    }
}
