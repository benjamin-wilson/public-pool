import { StratumV1ClientStatistics } from './StratumV1ClientStatistics';

describe('StratumV1ClientStatistics', () => {
    const client = {
        id: 'client-id',
        address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
        clientName: 'bitaxe3',
        sessionId: '57a6f098'
    } as any;

    let clientStatisticsService: {
        insert: jest.Mock,
        update: jest.Mock
    };
    let statistics: StratumV1ClientStatistics;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-05-06T12:00:00Z'));
        clientStatisticsService = {
            insert: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined)
        };
        statistics = new StratumV1ClientStatistics(clientStatisticsService as any);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('should insert the first share bucket', async () => {
        await statistics.addShares(client, 64);

        expect(clientStatisticsService.insert).toHaveBeenCalledWith({
            time: new Date('2026-05-06T12:00:00Z').getTime(),
            shares: 64,
            acceptedCount: 1,
            address: client.address,
            clientName: client.clientName,
            sessionId: client.sessionId
        });
    });

    it('should update the current share bucket for additional shares', async () => {
        await statistics.addShares(client, 64);
        jest.setSystemTime(new Date('2026-05-06T12:01:01Z'));
        await statistics.addShares(client, 32);

        expect(clientStatisticsService.update).toHaveBeenCalledWith({
            time: new Date('2026-05-06T12:00:00Z').getTime(),
            shares: 96,
            acceptedCount: 2,
            address: client.address,
            clientName: client.clientName,
            sessionId: client.sessionId
        });
    });

    it('should create a new share bucket when the time slot changes', async () => {
        await statistics.addShares(client, 64);
        jest.setSystemTime(new Date('2026-05-06T12:10:00Z'));

        await statistics.addShares(client, 32);

        expect(clientStatisticsService.update).toHaveBeenCalledWith({
            time: new Date('2026-05-06T12:00:00Z').getTime(),
            shares: 64,
            acceptedCount: 1,
            address: client.address,
            clientName: client.clientName,
            sessionId: client.sessionId
        });
        expect(clientStatisticsService.insert).toHaveBeenLastCalledWith({
            time: new Date('2026-05-06T12:10:00Z').getTime(),
            shares: 32,
            acceptedCount: 1,
            address: client.address,
            clientName: client.clientName,
            sessionId: client.sessionId
        });
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

        expect(statistics.getSuggestedDifficulty(64)).toBe(512);
    });

    it('should decrease difficulty for slow submissions', async () => {
        for (let i = 0; i < 5; i++) {
            jest.setSystemTime(new Date(Date.parse('2026-05-06T12:00:00Z') + (i * 150000)));
            await statistics.addShares(client, 64);
        }

        expect(statistics.getSuggestedDifficulty(128)).toBe(4);
    });
});
