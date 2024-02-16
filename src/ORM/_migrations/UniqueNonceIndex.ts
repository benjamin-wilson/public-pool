import { MigrationInterface, QueryRunner } from 'typeorm';

export class UniqueNonceIndex implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE UNIQUE INDEX "IDX_unique_nonce" ON "client_entity" ("sessionId") WHERE "deletedAt" IS NOT NULL`
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_unique_nonce"`);
    }

}