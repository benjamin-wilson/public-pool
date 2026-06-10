import { MigrationInterface, QueryRunner } from 'typeorm';

export class AcceptedShareRetentionCompression1780966200000 implements MigrationInterface {
    public name = 'AcceptedShareRetentionCompression1780966200000';
    public transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "accepted_share_entity" SET (
                timescaledb.compress,
                timescaledb.compress_orderby = '"acceptedAt" DESC',
                timescaledb.compress_segmentby = '"address","clientName"'
            )
        `);

        await queryRunner.query(`SELECT remove_compression_policy('accepted_share_entity', if_exists => TRUE)`);
        await queryRunner.query(`
            SELECT add_compression_policy(
                'accepted_share_entity',
                INTERVAL '24 hours',
                if_not_exists => TRUE
            )
        `);

        await queryRunner.query(`SELECT remove_retention_policy('accepted_share_entity', if_exists => TRUE)`);
        await queryRunner.query(`
            SELECT add_retention_policy(
                'accepted_share_entity',
                INTERVAL '7 days',
                if_not_exists => TRUE
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`SELECT remove_compression_policy('accepted_share_entity', if_exists => TRUE)`);
        await queryRunner.query(`
            SELECT add_compression_policy(
                'accepted_share_entity',
                INTERVAL '1 day',
                if_not_exists => TRUE
            )
        `);

        await queryRunner.query(`SELECT remove_retention_policy('accepted_share_entity', if_exists => TRUE)`);
        await queryRunner.query(`
            SELECT add_retention_policy(
                'accepted_share_entity',
                INTERVAL '30 days',
                if_not_exists => TRUE
            )
        `);
    }
}
