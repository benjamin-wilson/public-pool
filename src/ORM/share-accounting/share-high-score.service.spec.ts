import { DataSource, EntityManager } from 'typeorm';

import { ShareHighScoreService } from './share-high-score.service';

describe('ShareHighScoreService', () => {
    it('orders aggregate candidates numerically and retains all-time client/address highs', async () => {
        const upserts: unknown[][] = [];
        const manager = {
            query: jest.fn(async (sql: string, params: unknown[] = []) => {
                if (sql.includes('pg_try_advisory_xact_lock')) {
                    return [{ locked: true }];
                }
                if (sql.includes('WITH candidate_rows')) {
                    expect(sql).toContain('"bestSubmissionDifficulty"::numeric DESC');
                    return [];
                }
                if (sql.includes('FROM "accepted_share_block_10m"')) {
                    return [];
                }
                if (sql.includes('FROM "client_entity"')) {
                    const payoutMode = params[0] as string | undefined;
                    const difficultyByMode = {
                        solo: '10828324014691.838',
                        pplns: '2688488439606.743',
                        all: '10828324014691.838',
                    };
                    const mode = payoutMode ?? 'all';
                    return [{
                        submissionDifficulty: difficultyByMode[mode],
                        acceptedAt: new Date('2026-07-16T06:33:41.270Z'),
                        address: 'bc1qe4zjanpz5tg96a278ew3l2g0h9h0qddgcdvp43',
                        clientName: 'bitaxe',
                        protocol: 'bitaxe',
                    }];
                }
                if (sql.includes('FROM "address_settings_entity"')) {
                    return [{
                        submissionDifficulty: '294141974944674.8',
                        acceptedAt: new Date('2026-07-10T03:31:15.987Z'),
                        address: 'bc1q0pp74ghs25vpn2ah6auz4vkehvzy8z8ddyzts7',
                        protocol: 'bitaxe',
                    }];
                }
                if (sql.includes('INSERT INTO "accepted_share_high_score"')) {
                    upserts.push(params);
                    return [{ inserted: 1 }];
                }
                throw new Error(`Unexpected query: ${sql}`);
            }),
        } as unknown as EntityManager;
        const dataSource = {
            transaction: jest.fn((callback: (manager: EntityManager) => Promise<unknown>) => callback(manager)),
        } as unknown as DataSource;
        const service = new ShareHighScoreService(dataSource);

        await expect(service.refreshHighScores()).resolves.toEqual({
            processed: true,
            updatedRows: 4,
        });

        expect(upserts).toEqual(expect.arrayContaining([
            expect.arrayContaining(['all_time', 'all', '1970-01-01', '294141974944674.8']),
            expect.arrayContaining(['all_time', 'solo', '1970-01-01', '10828324014691.838']),
            expect.arrayContaining(['all_time', 'pplns', '1970-01-01', '2688488439606.743']),
        ]));
    });
});
