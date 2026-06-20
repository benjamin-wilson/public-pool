import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';

import { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { IMiningInfo } from '../models/bitcoin-rpc/IMiningInfo';

const MINING_INFO_CHANNEL = 'mining-info.updated';
const MINING_INFO_KEY = 'mining-info:latest';
const BLOCK_TEMPLATE_LATEST_KEY = 'block-template:latest';
const blockTemplateKey = (height: number) => `block-template:${height}`;
const jsonCacheKey = (key: string) => `json-cache:${key}`;

@Injectable()
export class RedisMessagingService implements OnModuleInit, OnModuleDestroy {
    private publisher: RedisClientType;
    private subscriber: RedisClientType;
    private connected = false;

    constructor(
        private readonly configService: ConfigService,
    ) { }

    public async onModuleInit() {
        await this.connect().catch(error => {
            console.error(`Redis unavailable at startup: ${error.message}`);
        });
    }

    public async onModuleDestroy() {
        await Promise.all([
            this.publisher?.quit().catch(() => undefined),
            this.subscriber?.quit().catch(() => undefined),
        ]);
    }

    public async connect() {
        if (this.connected) {
            return;
        }

        const url = this.configService.get<string>('REDIS_URL') ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
        const socket = {
            reconnectStrategy: (retries: number) => Math.min(retries * 250, 5000),
        };
        this.publisher = createClient({ url, socket });
        this.subscriber = createClient({ url, socket });

        this.publisher.on('error', error => console.error(`Redis publisher error: ${error.message}`));
        this.subscriber.on('error', error => console.error(`Redis subscriber error: ${error.message}`));
        this.publisher.on('end', () => { this.connected = false; });
        this.subscriber.on('end', () => { this.connected = false; });

        await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
        this.connected = true;
    }

    public async publishMiningInfoUpdate(miningInfo: IMiningInfo) {
        if (!await this.ensureConnected()) {
            return;
        }
        await this.publisher.publish(MINING_INFO_CHANNEL, JSON.stringify(miningInfo));
    }

    public async subscribeMiningInfoUpdates(handler: (miningInfo: IMiningInfo) => Promise<void>) {
        if (!await this.ensureConnected()) {
            return;
        }
        await this.subscriber.subscribe(MINING_INFO_CHANNEL, async message => {
            try {
                await handler(JSON.parse(message));
            } catch (error) {
                console.error(`Invalid Redis mining info update: ${error.message}`);
            }
        });
    }

    public async setLatestMiningInfo(miningInfo: IMiningInfo) {
        if (!await this.ensureConnected()) {
            return;
        }
        await this.publisher.set(MINING_INFO_KEY, JSON.stringify(miningInfo));
    }

    public async getLatestMiningInfo(): Promise<IMiningInfo | null> {
        if (!await this.ensureConnected()) {
            return null;
        }
        const value = await this.publisher.get(MINING_INFO_KEY);
        return value == null ? null : JSON.parse(value as string);
    }

    public async setBlockTemplate(height: number, blockTemplate: IBlockTemplate) {
        if (!await this.ensureConnected()) {
            return;
        }
        const serialized = JSON.stringify(blockTemplate);
        await Promise.all([
            this.publisher.set(blockTemplateKey(height), serialized),
            this.publisher.set(BLOCK_TEMPLATE_LATEST_KEY, serialized),
        ]);
    }

    public async getBlockTemplate(height: number): Promise<IBlockTemplate | null> {
        if (!await this.ensureConnected()) {
            return null;
        }
        const value = await this.publisher.get(blockTemplateKey(height));
        return value == null ? null : JSON.parse(value as string);
    }

    public async getLatestBlockTemplate(): Promise<IBlockTemplate | null> {
        if (!await this.ensureConnected()) {
            return null;
        }
        const value = await this.publisher.get(BLOCK_TEMPLATE_LATEST_KEY);
        return value == null ? null : JSON.parse(value as string);
    }

    public async getJsonCache<T>(key: string): Promise<T | null> {
        if (!await this.ensureConnected()) {
            return null;
        }

        const value = await this.publisher.get(jsonCacheKey(key));
        if (value == null) {
            return null;
        }

        try {
            return JSON.parse(value as string) as T;
        } catch (error) {
            console.error(`Invalid Redis JSON cache for ${key}: ${error.message}`);
            await this.publisher.del(jsonCacheKey(key));
            return null;
        }
    }

    public async setJsonCache(key: string, value: unknown, ttlMs: number): Promise<void> {
        if (!await this.ensureConnected() || ttlMs <= 0) {
            return;
        }

        await this.publisher.setEx(
            jsonCacheKey(key),
            Math.max(1, Math.ceil(ttlMs / 1000)),
            JSON.stringify(value),
        );
    }

    private async ensureConnected(): Promise<boolean> {
        if (!this.connected) {
            try {
                await this.connect();
            } catch (error) {
                console.error(`Redis messaging degraded: ${error.message}`);
                return false;
            }
        }
        return true;
    }

}
