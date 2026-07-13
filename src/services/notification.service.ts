import { Injectable, OnModuleInit } from '@nestjs/common';
import { Block } from 'bitcoinjs-lib';

import { DiscordService } from './discord.service';
import { BlockFoundNotification, RedisMessagingService } from './redis-messaging.service';
import { TelegramService } from './telegram.service';

const BLOCK_NOTIFICATION_DEDUPE_TTL_MS = 10 * 60 * 1000;
const BLOCK_NOTIFICATION_DEDUPE_MAX_ENTRIES = 1000;

@Injectable()
export class NotificationService implements OnModuleInit {
    private readonly processedBlockNotifications = new Map<string, number>();

    constructor(
        private readonly telegramService: TelegramService,
        private readonly discordService: DiscordService,
        private readonly redisMessagingService: RedisMessagingService
    ) { }

    async onModuleInit(): Promise<void> {
        if (process.env.MASTER !== 'true') {
            return;
        }

        await this.redisMessagingService.subscribeBlockFoundNotifications(async notification => {
            await this.dispatchBlockFoundNotification(notification);
        });
        await this.discordService.notifyRestarted();
    }

    public async notifySubscribersBlockFound(address: string, height: number, block: Block, message: string) {
        const blockHash = this.getBlockHash(block);
        const notification: BlockFoundNotification = {
            schemaVersion: 1,
            eventId: this.createBlockFoundEventId(address, height, blockHash, message),
            address,
            height,
            blockHash,
            message,
            publishedAtMs: Date.now(),
        };

        if (process.env.MASTER === 'true') {
            await this.dispatchBlockFoundNotification(notification, block);
            return;
        }

        const published = await this.redisMessagingService.publishBlockFoundNotification(notification);
        if (!published) {
            console.error(`Unable to publish block found notification ${notification.eventId}`);
        }
    }

    private async dispatchBlockFoundNotification(
        notification: BlockFoundNotification,
        block?: Block,
    ): Promise<void> {
        if (this.hasProcessedBlockNotification(notification.eventId)) {
            return;
        }
        await this.discordService.notifySubscribersBlockFound(notification.height, block, notification.message);
        await this.telegramService.notifySubscribersBlockFound(
            notification.address,
            notification.height,
            block,
            notification.message,
        );
    }

    private createBlockFoundEventId(
        address: string,
        height: number,
        blockHash: string,
        message: string,
    ): string {
        if (blockHash !== 'unknown') {
            return `block-found:${height}:${blockHash}:${address}`;
        }
        return `block-found:${height}:${address}:${message}`;
    }

    private getBlockHash(block: Block): string {
        try {
            const maybeBlock = block as Block & {
                getId?: () => string;
                getHash?: () => Buffer;
            };
            if (typeof maybeBlock.getId === 'function') {
                const id = maybeBlock.getId();
                return typeof id === 'string' && id.length > 0 ? id : 'unknown';
            }
            if (typeof maybeBlock.getHash === 'function') {
                return Buffer.from(maybeBlock.getHash()).reverse().toString('hex');
            }
        } catch {
            return 'unknown';
        }
        return 'unknown';
    }

    private hasProcessedBlockNotification(eventId: string): boolean {
        const now = Date.now();
        for (const [key, processedAtMs] of this.processedBlockNotifications) {
            if (now - processedAtMs > BLOCK_NOTIFICATION_DEDUPE_TTL_MS
                || this.processedBlockNotifications.size > BLOCK_NOTIFICATION_DEDUPE_MAX_ENTRIES) {
                this.processedBlockNotifications.delete(key);
            }
        }
        if (this.processedBlockNotifications.has(eventId)) {
            return true;
        }
        this.processedBlockNotifications.set(eventId, now);
        return false;
    }
}
