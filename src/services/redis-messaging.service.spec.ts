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
        subscriptions.clear();
        clientsByRole.publisher = null;
        clientsByRole.subscriber = null;
        clientsByRole.urgentPublisher = null;
        clientsByRole.urgentSubscriber = null;
        clients = [
            createRedisClient(),
            createRedisClient(),
            createRedisClient(),
            createRedisClient(),
        ];
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
        await service.setBlockTemplate(900000, {
            height: 900001,
            previousblockhash: 'aa'.repeat(32),
            payoutMode: 'solo',
            transactions: [],
        } as any);

        expect(await service.getLatestMiningInfo()).toEqual({ blocks: 900000 });
        expect(await service.getBlockTemplate(900000)).toEqual(expect.objectContaining({
            height: 900001,
            payoutMode: 'solo',
        }));
        expect(await service.getLatestBlockTemplate()).toEqual(expect.objectContaining({
            height: 900001,
            payoutMode: 'solo',
        }));
    });

    it('keeps the legacy latest key as JSON and writes it only when explicitly ready', async () => {
        await service.connect();
        const template = {
            height: 900001,
            previousblockhash: 'ab'.repeat(32),
            payoutMode: 'pplns',
            payoutSnapshotId: 'safe-snapshot',
            transactions: [],
        } as any;

        await service.setBlockTemplate(900000, template);
        expect(store.has('block-template:latest')).toBe(false);
        expect(store.has('block-template:900000')).toBe(false);

        await service.setLegacyBlockTemplate(900000, template);

        expect(JSON.parse(store.get('block-template:latest')!)).toEqual(template);
        expect(JSON.parse(store.get('block-template:900000')!)).toEqual(template);
    });

    it('never uses a tagged legacy template for the wrong payout mode', async () => {
        await service.connect();
        const solo = {
            height: 900001,
            previousblockhash: 'ac'.repeat(32),
            payoutMode: 'solo',
            transactions: [],
        } as any;
        await service.setLegacyBlockTemplate(900000, solo);

        expect(await service.getBlockTemplate(900000, 'solo')).toEqual(solo);
        expect(await service.getBlockTemplate(900000, 'pplns')).toBeNull();

        const oldCombined = { ...solo };
        delete oldCombined.payoutMode;
        await service.setLegacyBlockTemplate(900000, oldCombined);
        expect(await service.getBlockTemplate(900000, 'solo')).toEqual(oldCombined);
        expect(await service.getBlockTemplate(900000, 'pplns')).toEqual(oldCombined);
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
        await subscriptions.get('mining-info.updated')!('{bad json');

        expect(handler).not.toHaveBeenCalled();
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid Redis mining info update'));
        consoleSpy.mockRestore();
    });

    it('stores payout variants and same-height reorg templates under distinct tip keys', async () => {
        await service.connect();
        const firstHash = '11'.repeat(32);
        const reorgHash = '22'.repeat(32);

        await service.setBlockTemplate(900000, {
            height: 900001,
            previousblockhash: firstHash,
            payoutMode: 'solo',
            transactions: [],
        } as any);
        await service.setBlockTemplate(900000, {
            height: 900001,
            previousblockhash: firstHash,
            payoutMode: 'pplns',
            payoutSnapshotId: '7',
            transactions: [],
        } as any);
        await service.setBlockTemplate(900000, {
            height: 900001,
            previousblockhash: reorgHash,
            payoutMode: 'solo',
            transactions: [],
        } as any);

        expect((await service.getBlockTemplate(900000, 'solo', firstHash))?.previousblockhash).toBe(firstHash);
        expect((await service.getBlockTemplate(900000, 'solo'))?.previousblockhash).toBe(reorgHash);
        expect((await service.getBlockTemplate(900000, 'pplns', firstHash))?.payoutSnapshotId).toBe('7');
        expect((await service.getLatestBlockTemplate('pplns'))?.payoutMode).toBe('pplns');
    });

    it('publishes validated block template update envelopes', async () => {
        await service.connect();
        const handler = jest.fn().mockResolvedValue(undefined);
        const update = {
            schemaVersion: 1 as const,
            eventId: 'new-block:1',
            height: 900001,
            previousBlockHash: '33'.repeat(32),
            payoutMode: 'solo' as const,
            publishedAtMs: 123,
        };

        await service.subscribeBlockTemplateUpdates(handler);
        await service.publishBlockTemplateUpdate(update);

        expect(handler).toHaveBeenCalledWith(update);
    });

    it('ignores malformed block template update envelopes', async () => {
        await service.connect();
        const handler = jest.fn();
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        await service.subscribeBlockTemplateUpdates(handler);

        await subscriptions.get('block-template.updated')!(JSON.stringify({ schemaVersion: 2 }));

        expect(handler).not.toHaveBeenCalled();
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid Redis block template update'));
        consoleSpy.mockRestore();
    });

    it('publishes validated block found notifications', async () => {
        await service.connect();
        const handler = jest.fn().mockResolvedValue(undefined);
        const notification = {
            schemaVersion: 1 as const,
            eventId: 'block-found:900001:blockhash:bc1qminer',
            address: 'bc1qminer',
            height: 900001,
            blockHash: 'aa'.repeat(32),
            message: 'accepted',
            publishedAtMs: 123,
        };

        await service.subscribeBlockFoundNotifications(handler);
        await expect(service.publishBlockFoundNotification(notification)).resolves.toBe(true);

        expect(handler).toHaveBeenCalledWith(notification);
    });

    it('ignores malformed block found notifications', async () => {
        await service.connect();
        const handler = jest.fn();
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        await service.subscribeBlockFoundNotifications(handler);

        await subscriptions.get('block-found.notification')!(JSON.stringify({
            schemaVersion: 1,
            eventId: '',
            height: 900001,
        }));

        expect(handler).not.toHaveBeenCalled();
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid Redis block found notification'));
        consoleSpy.mockRestore();
    });

    it('stores, publishes, and replays compact SV1 bridge updates', async () => {
        await service.connect();
        const handler = jest.fn().mockResolvedValue(undefined);
        const update = {
            schemaVersion: 1 as const,
            type: 'subsidy-bridge' as const,
            eventId: 'bridge:900001:hash',
            publishedAtMs: 123,
            template: {
                height: 900001,
                previousblockhash: '44'.repeat(32),
                payoutMode: 'solo' as const,
                jobType: 'empty' as const,
                transactions: [],
            } as any,
        };

        await service.subscribeSv1BridgeUpdates(handler);
        await expect(service.publishSv1BridgeUpdate(update)).resolves.toBe(true);

        expect(handler).toHaveBeenCalledWith(expect.objectContaining({
            ...update,
            workerReceivedAtMs: expect.any(Number),
        }));
        expect(await service.getLatestSv1BridgeUpdate()).toEqual(update);
    });

    it('uses the normal command socket as an explicit bridge fallback lane', async () => {
        await service.connect();
        const update = createBridgeUpdate('solo', 'fallback-bridge');

        await expect(service.publishSv1BridgeUpdate(update, 'fallback')).resolves.toBe(true);

        expect(clientsByRole.publisher.publish).toHaveBeenCalledWith(
            'sv1-bridge.updated',
            JSON.stringify(update),
        );
        expect(clientsByRole.urgentPublisher.publish).not.toHaveBeenCalled();
    });

    it('publishes compact prestage activation on the urgent socket', async () => {
        await service.connect();
        const handler = jest.fn().mockResolvedValue(undefined);
        const activation = createPrestageActivation();

        await service.subscribeSv1PrestageActivations(handler);
        await expect(service.publishSv1PrestageActivation(activation)).resolves.toBe(true);

        expect(clientsByRole.urgentPublisher.publish).toHaveBeenCalledWith(
            'sv1-prestage.activate',
            JSON.stringify(activation),
        );
        expect(handler).toHaveBeenCalledWith(expect.objectContaining({
            ...activation,
            workerReceivedAtMs: expect.any(Number),
        }));
    });

    it('uses the normal Redis socket for compact activation fallback', async () => {
        await service.connect();
        const activation = createPrestageActivation();

        await expect(service.publishSv1PrestageActivation(
            activation,
            'fallback',
        )).resolves.toBe(true);

        expect(clientsByRole.publisher.publish).toHaveBeenCalledWith(
            'sv1-prestage.activate',
            JSON.stringify(activation),
        );
    });

    it('rejects malformed compact prestage activation fields', async () => {
        await service.connect();
        const activation = createPrestageActivation();

        await expect(service.publishSv1PrestageActivation({
            ...activation,
            previousBlockHash: 'not-a-hash',
        })).rejects.toThrow('unsupported SV1 prestage activation');
        await expect(service.publishSv1PrestageActivation({
            ...activation,
            payoutMode: 'pplns',
        })).rejects.toThrow('unsupported SV1 prestage activation');
    });

    it('reports bridge delivery failure when Redis cannot connect', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        clients[0].connect.mockRejectedValueOnce(new Error('redis unavailable'));

        await expect(service.publishSv1BridgeUpdate(
            createBridgeUpdate('solo', 'unavailable-bridge'),
        )).resolves.toBe(false);

        errorSpy.mockRestore();
    });

    it('stores and replays the latest SV1 bridge independently by payout mode', async () => {
        await service.connect();
        const solo = createBridgeUpdate('solo', 'solo-bridge');
        const pplns = createBridgeUpdate('pplns', 'pplns-bridge');

        await service.publishSv1BridgeUpdate(solo);
        await service.publishSv1BridgeUpdate(pplns);

        expect(await service.getLatestSv1BridgeUpdate('solo')).toEqual(solo);
        expect(await service.getLatestSv1BridgeUpdate('pplns')).toEqual(pplns);
        expect(store.get('sv1-bridge:latest:solo')).toBe(JSON.stringify(solo));
        expect(store.get('sv1-bridge:latest:pplns')).toBe(JSON.stringify(pplns));
    });

    it('publishes and durably replays next-height SV1 prestage templates', async () => {
        await service.connect();
        const handler = jest.fn().mockResolvedValue(undefined);
        const update = {
            schemaVersion: 1 as const,
            type: 'subsidy-prestage' as const,
            eventId: 'prestage:solo:900002',
            preparedAtMs: 456,
            template: {
                height: 900002,
                previousblockhash: '0'.repeat(64),
                payoutMode: 'solo' as const,
                jobType: 'empty' as const,
                transactions: [],
            } as any,
        };

        await service.subscribeSv1PrestageUpdates(handler);
        await service.publishSv1PrestageUpdate(update);

        expect(handler).toHaveBeenCalledWith(update);
        expect(await service.getLatestSv1PrestageUpdates()).toEqual([update]);
    });

    it('rejects a prestage template that claims an authoritative prevhash', async () => {
        await service.connect();
        const update = {
            schemaVersion: 1 as const,
            type: 'subsidy-prestage' as const,
            eventId: 'unsafe-prestage',
            preparedAtMs: 456,
            template: {
                height: 900002,
                previousblockhash: '11'.repeat(32),
                payoutMode: 'solo' as const,
                jobType: 'empty' as const,
                transactions: [],
            } as any,
        };

        await expect(service.publishSv1PrestageUpdate(update)).rejects.toThrow(
            'unsupported SV1 prestage update',
        );
    });

    it('rejects PPLNS bridges without an explicit snapshot and fixed-value outputs', async () => {
        await service.connect();
        const valid = createBridgeUpdate('pplns', 'pplns-valid');
        const invalidUpdates = [
            {
                ...valid,
                template: { ...valid.template, payoutSnapshotId: undefined },
            },
            {
                ...valid,
                template: { ...valid.template, payoutOutputs: [] },
            },
            {
                ...valid,
                template: {
                    ...valid.template,
                    payoutOutputs: [{ address: 'bc1qpercentage', percent: 100 }],
                },
            },
            {
                ...valid,
                template: {
                    ...valid.template,
                    payoutOutputs: [{ address: 'bc1qpartial', amountSats: 1 }],
                },
            },
        ];

        for (const update of invalidUpdates) {
            await expect(service.publishSv1BridgeUpdate(update as any)).rejects.toThrow(
                'unsupported SV1 bridge update',
            );
        }
        expect(await service.getLatestSv1BridgeUpdate('pplns')).toBeNull();
    });

    it('rejects non-empty bridge templates from the shared bridge channel', async () => {
        await service.connect();
        const handler = jest.fn();
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        await service.subscribeSv1BridgeUpdates(handler);

        await subscriptions.get('sv1-bridge.updated')!(JSON.stringify({
            schemaVersion: 1,
            type: 'subsidy-bridge',
            eventId: 'bad',
            template: {
                height: 1,
                previousblockhash: '00'.repeat(32),
                payoutMode: 'pplns',
                jobType: 'empty',
                transactions: [{ data: '00' }],
            },
        }));

        expect(handler).not.toHaveBeenCalled();
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid Redis SV1 bridge update'));
        consoleSpy.mockRestore();
    });

});

function createBridgeUpdate(payoutMode: 'solo' | 'pplns', eventId: string) {
    const isPplns = payoutMode === 'pplns';
    return {
        schemaVersion: 1 as const,
        type: 'subsidy-bridge' as const,
        eventId,
        publishedAtMs: 123,
        template: {
            height: 900001,
            previousblockhash: '55'.repeat(32),
            payoutMode,
            jobType: 'empty' as const,
            transactions: [],
            coinbasevalue: 312_500_000,
            payoutSnapshotId: isPplns ? 'snapshot-55' : undefined,
            payoutOutputs: isPplns
                ? [{ address: 'bc1qpplns', amountSats: 312_500_000 }]
                : undefined,
        } as any,
    };
}

function createPrestageActivation() {
    return {
        schemaVersion: 1 as const,
        type: 'prestage-activation' as const,
        eventId: 'activate:solo:900001',
        height: 900001,
        previousBlockHash: '55'.repeat(32),
        version: 0x20000000,
        bits: '17034219',
        minTime: 1_700_000_000,
        currentTime: 1_700_000_001,
        subsidySats: 312_500_000,
        payoutMode: 'solo' as const,
        requiredVersionBits: 0,
        sourceNotificationReceivedAtMs: 123,
        publishedAtMs: 124,
    };
}

const store = new Map<string, string>();
const sets = new Map<string, Set<string>>();
const clientsByRole: {
    publisher?: any;
    subscriber?: any;
    urgentPublisher?: any;
    urgentSubscriber?: any;
} = {};
const subscriptions = new Map<string, (message: string) => Promise<void>>();

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
            void subscriptions.get(channel)?.(value);
            return Promise.resolve(1);
        }),
        subscribe: jest.fn((channel: string, callback: (message: string) => Promise<void>) => {
            subscriptions.set(channel, callback);
            return Promise.resolve();
        }),
    };

    const role = (['publisher', 'subscriber', 'urgentPublisher', 'urgentSubscriber'] as const)
        .find(candidate => clientsByRole[candidate] == null);
    if (role == null) {
        throw new Error('Unexpected extra Redis test client');
    }
    clientsByRole[role] = client;

    return client;
}
