import { MigrationInterface, QueryRunner } from 'typeorm';

export class PayoutSnapshots1780969800000 implements MigrationInterface {
    public name = 'PayoutSnapshots1780969800000';
    public transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "payout_snapshot" (
                "id" bigserial PRIMARY KEY,
                "method" varchar(32) NOT NULL,
                "status" varchar(16) NOT NULL DEFAULT 'finalized',
                "blockHeight" bigint NOT NULL,
                "coinbaseValueSats" bigint NOT NULL,
                "networkDifficulty" numeric NOT NULL,
                "windowTargetDifficulty" numeric NOT NULL DEFAULT 0,
                "windowFactor" numeric NOT NULL DEFAULT 4,
                "feeAddress" varchar(62),
                "feeSats" bigint NOT NULL DEFAULT 0,
                "minPayoutSats" integer NOT NULL DEFAULT 546,
                "coinbaseWeightBudget" integer NOT NULL DEFAULT 50000,
                "startBatchId" bigint NOT NULL REFERENCES "share_rollup_batch" ("id"),
                "endBatchId" bigint NOT NULL REFERENCES "share_rollup_batch" ("id"),
                "windowStartShareIndex" bigint NOT NULL,
                "windowEndShareIndex" bigint NOT NULL,
                "totalCreditedDifficulty" numeric NOT NULL,
                "totalAcceptedShareCount" bigint NOT NULL,
                "eligibleAddressCount" integer NOT NULL,
                "includedOutputCount" integer NOT NULL,
                "distributedSats" bigint NOT NULL,
                "unallocatedRemainderSats" bigint NOT NULL,
                "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_payout_snapshot_latest"
            ON "payout_snapshot" ("status", "createdAt" DESC, "id" DESC)
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_payout_snapshot_window"
            ON "payout_snapshot" ("windowEndShareIndex" DESC)
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "IDX_payout_snapshot_template_window"
            ON "payout_snapshot" ("method", "blockHeight", "coinbaseValueSats", "windowEndShareIndex")
            WHERE "status" = 'finalized'
        `);

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "payout_snapshot_entry" (
                "id" bigserial PRIMARY KEY,
                "snapshotId" bigint NOT NULL REFERENCES "payout_snapshot" ("id") ON DELETE CASCADE,
                "address" varchar(62) NOT NULL,
                "creditedDifficulty" numeric NOT NULL,
                "acceptedShareCount" bigint NOT NULL,
                "payoutWeight" numeric NOT NULL,
                "grossPayoutSats" bigint NOT NULL,
                "payoutSats" bigint NOT NULL,
                "balanceBeforeSats" bigint NOT NULL DEFAULT 0,
                "balanceAfterSats" bigint NOT NULL DEFAULT 0,
                "includedInCoinbase" boolean NOT NULL DEFAULT true,
                "rowType" varchar(16) NOT NULL DEFAULT 'coinbase',
                "rank" integer NOT NULL,
                "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "IDX_payout_snapshot_entry_snapshot_address"
            ON "payout_snapshot_entry" ("snapshotId", "address")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_payout_snapshot_entry_snapshot_rank"
            ON "payout_snapshot_entry" ("snapshotId", "rank")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_payout_snapshot_entry_address"
            ON "payout_snapshot_entry" ("address")
        `);

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "payout_balance" (
                "address" varchar(62) PRIMARY KEY,
                "balanceSats" bigint NOT NULL DEFAULT 0,
                "totalPaidSats" bigint NOT NULL DEFAULT 0,
                "lastAcceptedShareAt" timestamptz,
                "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_payout_balance_nonzero"
            ON "payout_balance" ("balanceSats")
            WHERE "balanceSats" != 0
        `);

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "payout_history" (
                "id" bigserial PRIMARY KEY,
                "blockHeight" bigint NOT NULL,
                "payoutSnapshotId" bigint NOT NULL REFERENCES "payout_snapshot" ("id") ON DELETE CASCADE,
                "address" varchar(62) NOT NULL,
                "paidSats" bigint NOT NULL DEFAULT 0,
                "percent" numeric NOT NULL DEFAULT 0,
                "balanceBeforeSats" bigint NOT NULL DEFAULT 0,
                "balanceAfterSats" bigint NOT NULL DEFAULT 0,
                "rowType" varchar(16) NOT NULL DEFAULT 'coinbase',
                "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "UQ_payout_history_block_address"
            ON "payout_history" ("blockHeight", "address")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_payout_history_address_created"
            ON "payout_history" ("address", "createdAt" DESC)
        `);

        await queryRunner.query(`ALTER TABLE "blocks_entity" ADD COLUMN IF NOT EXISTS "payoutSnapshotId" bigint`);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_blocks_payout_snapshot"
            ON "blocks_entity" ("payoutSnapshotId")
            WHERE "payoutSnapshotId" IS NOT NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_blocks_payout_snapshot"`);
        await queryRunner.query(`ALTER TABLE "blocks_entity" DROP COLUMN IF EXISTS "payoutSnapshotId"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payout_history_address_created"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "UQ_payout_history_block_address"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "payout_history"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payout_balance_nonzero"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "payout_balance"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payout_snapshot_entry_address"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payout_snapshot_entry_snapshot_rank"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payout_snapshot_entry_snapshot_address"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "payout_snapshot_entry"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payout_snapshot_template_window"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payout_snapshot_window"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payout_snapshot_latest"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "payout_snapshot"`);
    }
}
