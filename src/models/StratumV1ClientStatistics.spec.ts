import { StratumV1ClientStatistics } from './StratumV1ClientStatistics';

describe('StratumV1ClientStatistics', () => {
    const client = {
        id: 'client-id',
        address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
        clientName: 'bitaxe3',
        sessionId: '57a6f098'
    } as any;

    let statistics: StratumV1ClientStatistics;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-05-06T12:00:00Z'));
        statistics = new StratumV1ClientStatistics();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('should keep runtime hashrate at zero before enough time passes', async () => {
        await statistics.addShares(client, 64);

        expect(statistics.hashRate).toBe(0);
    });

    it('should update runtime hashrate from accepted shares', async () => {
        for (let i = 0; i < 3; i++) {
            jest.setSystemTime(new Date(Date.parse('2026-05-06T12:00:00Z') + (i * 31000)));
            await statistics.addShares(client, 64);
        }

        expect(statistics.hashRate).toBeGreaterThan(0);
    });

    it('should not suggest a difficulty change before enough time or shares have passed', () => {
        expect(statistics.getSuggestedDifficulty(64)).toBeNull();
    });

    it('should lower difficulty when a miner has not submitted shares for several minutes', () => {
        jest.setSystemTime(new Date('2026-05-06T12:06:00Z'));

        expect(statistics.getSuggestedDifficulty(64)).toBe(8);
    });

    it('should increase difficulty for rapid submissions', async () => {
        for (let i = 0; i < 5; i++) {
            jest.setSystemTime(new Date(Date.parse('2026-05-06T12:00:00Z') + (i * 1000)));
            await statistics.addShares(client, 64);
        }

        expect(statistics.getSuggestedDifficulty(64)).toBe(2048);
    });

    it('should decrease difficulty for slow submissions', async () => {
        for (let i = 0; i < 5; i++) {
            jest.setSystemTime(new Date(Date.parse('2026-05-06T12:00:00Z') + (i * 150000)));
            await statistics.addShares(client, 64);
        }

        expect(statistics.getSuggestedDifficulty(128)).toBe(16);
    });
});
