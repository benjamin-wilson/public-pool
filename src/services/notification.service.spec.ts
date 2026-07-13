import { Block } from 'bitcoinjs-lib';

import { NotificationService } from './notification.service';

describe('NotificationService', () => {
    const originalMaster = process.env.MASTER;
    let telegramService: { notifySubscribersBlockFound: jest.Mock };
    let discordService: {
        notifyRestarted: jest.Mock;
        notifySubscribersBlockFound: jest.Mock;
    };
    let redisMessagingService: {
        publishBlockFoundNotification: jest.Mock;
        subscribeBlockFoundNotifications: jest.Mock;
    };

    beforeEach(() => {
        telegramService = {
            notifySubscribersBlockFound: jest.fn().mockResolvedValue(undefined),
        };
        discordService = {
            notifyRestarted: jest.fn().mockResolvedValue(undefined),
            notifySubscribersBlockFound: jest.fn().mockResolvedValue(undefined),
        };
        redisMessagingService = {
            publishBlockFoundNotification: jest.fn().mockResolvedValue(true),
            subscribeBlockFoundNotifications: jest.fn().mockResolvedValue(undefined),
        };
    });

    afterEach(() => {
        process.env.MASTER = originalMaster;
        jest.clearAllMocks();
    });

    it('publishes block found notifications from worker processes', async () => {
        process.env.MASTER = 'false';
        const service = createService();

        await service.notifySubscribersBlockFound(
            'bc1qminer',
            900001,
            createBlock('11'.repeat(32)),
            'accepted',
        );

        expect(redisMessagingService.publishBlockFoundNotification).toHaveBeenCalledWith({
            schemaVersion: 1,
            eventId: 'block-found:900001:1111111111111111111111111111111111111111111111111111111111111111:bc1qminer',
            address: 'bc1qminer',
            height: 900001,
            blockHash: '11'.repeat(32),
            message: 'accepted',
            publishedAtMs: expect.any(Number),
        });
        expect(discordService.notifySubscribersBlockFound).not.toHaveBeenCalled();
        expect(telegramService.notifySubscribersBlockFound).not.toHaveBeenCalled();
    });

    it('subscribes on the master process and dispatches received notifications', async () => {
        process.env.MASTER = 'true';
        const service = createService();

        await service.onModuleInit();
        const handler = redisMessagingService.subscribeBlockFoundNotifications.mock.calls[0][0];
        await handler({
            schemaVersion: 1,
            eventId: 'block-found:900001:blockhash:bc1qminer',
            address: 'bc1qminer',
            height: 900001,
            blockHash: 'blockhash',
            message: 'accepted',
            publishedAtMs: 123,
        });

        expect(redisMessagingService.subscribeBlockFoundNotifications).toHaveBeenCalledTimes(1);
        expect(discordService.notifyRestarted).toHaveBeenCalledTimes(1);
        expect(discordService.notifySubscribersBlockFound).toHaveBeenCalledWith(
            900001,
            undefined,
            'accepted',
        );
        expect(telegramService.notifySubscribersBlockFound).toHaveBeenCalledWith(
            'bc1qminer',
            900001,
            undefined,
            'accepted',
        );
    });

    it('deduplicates repeated master notifications for the same block event', async () => {
        process.env.MASTER = 'true';
        const service = createService();
        const notification = {
            schemaVersion: 1 as const,
            eventId: 'block-found:900001:blockhash:bc1qminer',
            address: 'bc1qminer',
            height: 900001,
            blockHash: 'blockhash',
            message: 'accepted',
            publishedAtMs: 123,
        };

        await service.onModuleInit();
        const handler = redisMessagingService.subscribeBlockFoundNotifications.mock.calls[0][0];
        await handler(notification);
        await handler(notification);

        expect(discordService.notifySubscribersBlockFound).toHaveBeenCalledTimes(1);
        expect(telegramService.notifySubscribersBlockFound).toHaveBeenCalledTimes(1);
    });

    it('dispatches directly when called in the master process', async () => {
        process.env.MASTER = 'true';
        const service = createService();
        const block = createBlock('22'.repeat(32));

        await service.notifySubscribersBlockFound('bc1qminer', 900002, block, 'accepted');

        expect(redisMessagingService.publishBlockFoundNotification).not.toHaveBeenCalled();
        expect(discordService.notifySubscribersBlockFound).toHaveBeenCalledWith(
            900002,
            block,
            'accepted',
        );
        expect(telegramService.notifySubscribersBlockFound).toHaveBeenCalledWith(
            'bc1qminer',
            900002,
            block,
            'accepted',
        );
    });

    function createService(): NotificationService {
        return new NotificationService(
            telegramService as any,
            discordService as any,
            redisMessagingService as any,
        );
    }
});

function createBlock(blockHash: string): Block {
    return {
        getId: () => blockHash,
    } as unknown as Block;
}
