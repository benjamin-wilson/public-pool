import { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveAcceptedShareRetention1780959000000 implements MigrationInterface {
    public name = 'RemoveAcceptedShareRetention1780959000000';
    public transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`SELECT remove_retention_policy('accepted_share_entity', if_exists => TRUE)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`SELECT add_retention_policy('accepted_share_entity', INTERVAL '30 days', if_not_exists => TRUE)`);
    }
}
