import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';

import { RedisMessagingService } from './redis-messaging.service';

jest.mock('redis', () => ({
    createClient: jest.fn(),
}));

describe('RedisMessagingService', () => {
    let clients: any[];
    let service: RedisMessagingService;

    beforeEach(() => {
        store.clear();
        sets.clear();
        clientsByRole.publisher = null;
        clientsByRole.subscriber = null;
        clients = [createRedisClient(), createRedisClient()];
        (createClient as jest.Mock).mockImplementation(() => clients.shift());
        service = new RedisMessagingService({
            get: jest.fn((key: string) => key === 'REDIS_URL' ? 'redis://test-redis:6379' : null),
        } as unknown as ConfigService);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('should store and replay latest mining info and block templates', async () => {
        await service.connect();

        await service.setLatestMiningInfo({ blocks: 900000 } as any);
        await service.setBlockTemplate(900000, { height: 900000, transactions: [] } as any);

        expect(await service.getLatestMiningInfo()).toEqual({ blocks: 900000 });
        expect(await service.getBlockTemplate(900000)).toEqual({ height: 900000, transactions: [] });
        expect(await service.getLatestBlockTemplate()).toEqual({ height: 900000, transactions: [] });
    });

    it('should publish and subscribe to mining info updates', async () => {
        await service.connect();
        const handler = jest.fn().mockResolvedValue(undefined);

        await service.subscribeMiningInfoUpdates(handler);
        await service.publishMiningInfoUpdate({ blocks: 900001 } as any);

        expect(handler).toHaveBeenCalledWith({ blocks: 900001 });
    });

    it('should ignore malformed pubsub messages', async () => {
        await service.connect();
        const handler = jest.fn();
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

        await service.subscribeMiningInfoUpdates(handler);
        await clientsByRole.subscriber.callback('{bad json');

        expect(handler).not.toHaveBeenCalled();
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid Redis mining info update'));
        consoleSpy.mockRestore();
    });

});

const store = new Map<string, string>();
const sets = new Map<string, Set<string>>();
const clientsByRole: { publisher?: any; subscriber?: any } = {};

function createRedisClient() {
    const client = {
        connect: jest.fn().mockResolvedValue(undefined),
        quit: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
        set: jest.fn((key: string, value: string) => {
            store.set(key, value);
            return Promise.resolve('OK');
        }),
        setEx: jest.fn((key: string, seconds: number, value: string) => {
            store.set(key, value);
            return Promise.resolve('OK');
        }),
        get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
        mGet: jest.fn((keys: string[]) => Promise.resolve(keys.map(key => store.get(key) ?? null))),
        del: jest.fn((...args: (string | string[])[]) => {
            const keys = args.flatMap(key => Array.isArray(key) ? key : [key]);
            let deleted = 0;
            keys.forEach(item => {
                deleted += store.delete(item) ? 1 : 0;
                deleted += sets.delete(item) ? 1 : 0;
            });
            return Promise.resolve(deleted);
        }),
        sAdd: jest.fn((key: string, value: string) => {
            const set = sets.get(key) ?? new Set<string>();
            set.add(value);
            sets.set(key, set);
            return Promise.resolve(1);
        }),
        sRem: jest.fn((key: string, value: string | string[]) => {
            const set = sets.get(key);
            const values = Array.isArray(value) ? value : [value];
            let deleted = 0;
            values.forEach(item => {
                deleted += set?.delete(item) ? 1 : 0;
            });
            return Promise.resolve(deleted);
        }),
        sMembers: jest.fn((key: string) => Promise.resolve([...sets.get(key) ?? []])),
        scanIterator: jest.fn(async function* scanIterator({ MATCH }: { MATCH: string }) {
            const prefix = MATCH.replace('*', '');
            for (const key of [...store.keys(), ...sets.keys()]) {
                if (key.startsWith(prefix)) {
                    yield key;
                }
            }
        }),
        publish: jest.fn((channel: string, value: string) => {
            void clientsByRole.subscriber?.callback(value);
            return Promise.resolve(1);
        }),
        subscribe: jest.fn((channel: string, callback: (message: string) => Promise<void>) => {
            clientsByRole.subscriber.callback = callback;
            return Promise.resolve();
        }),
    };

    if (clientsByRole.publisher == null) {
        clientsByRole.publisher = client;
    } else {
        clientsByRole.subscriber = client;
    }

    return client;
}
