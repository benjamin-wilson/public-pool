import { MigrationInterface, QueryRunner } from 'typeorm';

export class PoolSummaryRefreshWindow1781401000000 implements MigrationInterface {
    public name = 'PoolSummaryRefreshWindow1781401000000';
    public transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            SELECT remove_continuous_aggregate_policy(
                'accepted_share_pool_10m',
                if_exists => TRUE
            )
        `);
        await queryRunner.query(`
            SELECT add_continuous_aggregate_policy(
                'accepted_share_pool_10m',
                start_offset => INTERVAL '25 hours',
                end_offset => INTERVAL '1 minute',
                schedule_interval => INTERVAL '1 minute',
                if_not_exists => TRUE
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            SELECT remove_continuous_aggregate_policy(
                'accepted_share_pool_10m',
                if_exists => TRUE
            )
        `);
        await queryRunner.query(`
            SELECT add_continuous_aggregate_policy(
                'accepted_share_pool_10m',
                start_offset => INTERVAL '2 days',
                end_offset => INTERVAL '1 minute',
                schedule_interval => INTERVAL '1 minute',
                if_not_exists => TRUE
            )
        `);
    }
}
