import { MigrationInterface, QueryRunner } from 'typeorm';

export class AcceptedShareProtocolMetadata1781130600000 implements MigrationInterface {
    public name = 'AcceptedShareProtocolMetadata1781130600000';
    public transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await this.decompressAcceptedShareChunks(queryRunner);
        await queryRunner.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'accepted_share_entity'
                      AND column_name = 'protocol'
                      AND COALESCE(character_maximum_length, 0) < 16
                ) THEN
                    ALTER TABLE "accepted_share_entity" ALTER COLUMN "protocol" TYPE varchar(16);
                END IF;
            END
            $$
        `);
        await queryRunner.query(`ALTER TABLE "accepted_share_entity" ADD COLUMN IF NOT EXISTS "workSource" varchar(16) NOT NULL DEFAULT 'pool_template'`);
        await queryRunner.query(`ALTER TABLE "accepted_share_entity" ADD COLUMN IF NOT EXISTS "workProtocol" varchar(16) NOT NULL DEFAULT 'pool'`);
        await this.restoreAcceptedShareCompression(queryRunner);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_accepted_share_protocol_work"
            ON "accepted_share_entity" ("protocol", "workSource", "workProtocol", "acceptedAt" DESC)
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await this.decompressAcceptedShareChunks(queryRunner);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_accepted_share_protocol_work"`);
        await queryRunner.query(`ALTER TABLE "accepted_share_entity" DROP COLUMN IF EXISTS "workProtocol"`);
        await queryRunner.query(`ALTER TABLE "accepted_share_entity" DROP COLUMN IF EXISTS "workSource"`);
        await queryRunner.query(`ALTER TABLE "accepted_share_entity" ALTER COLUMN "protocol" TYPE varchar(8)`);
        await this.restoreAcceptedShareCompression(queryRunner);
    }

    private async decompressAcceptedShareChunks(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`SELECT remove_compression_policy('accepted_share_entity', if_exists => TRUE)`);
        await queryRunner.query(`
            DO $$
            DECLARE
                chunk_name regclass;
            BEGIN
                FOR chunk_name IN SELECT show_chunks('accepted_share_entity')
                LOOP
                    PERFORM decompress_chunk(chunk_name, if_compressed => TRUE);
                END LOOP;
            END
            $$
        `);
    }

    private async restoreAcceptedShareCompression(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "accepted_share_entity" SET (
                timescaledb.compress,
                timescaledb.compress_orderby = '"acceptedAt" DESC',
                timescaledb.compress_segmentby = '"address","clientName"'
            )
        `);
        await queryRunner.query(`
            SELECT add_compression_policy(
                'accepted_share_entity',
                INTERVAL '24 hours',
                if_not_exists => TRUE
            )
        `);
    }
}
