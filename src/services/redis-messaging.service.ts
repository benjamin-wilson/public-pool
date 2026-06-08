import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';

import { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { IMiningInfo } from '../models/bitcoin-rpc/IMiningInfo';

const MINING_INFO_CHANNEL = 'mining-info.updated';
const MINING_INFO_KEY = 'mining-info:latest';
const BLOCK_TEMPLATE_LATEST_KEY = 'block-template:latest';
const CLIENT_PRESENCE_TTL_SECONDS = 180;
const blockTemplateKey = (height: number) => `block-template:${height}`;
const CLIENT_PRESENCE_ALL_KEY = 'client-presence:all';
const clientPresenceKey = (clientId: string) => `client-presence:${clientId}`;
const clientPresenceAddressKey = (address: string) => `client-presence:address:${address}`;
const jsonCacheKey = (key: string) => `json-cache:${key}`;

export interface ClientPresence {
    clientId: string;
    address: string;
    clientName: string;
    sessionId: string;
    userAgent?: string | null;
    startTime: string;
    lastSeen: string;
    hashRate: number;
    bestDifficulty: number;
}

@Injectable()
export class RedisMessagingService implements OnModuleInit, OnModuleDestroy {
    private publisher: RedisClientType;
    private subscriber: RedisClientType;
    private connected = false;
    private readonly clientPresenceTtlSeconds: number;

    constructor(
        private readonly configService: ConfigService,
    ) {
        this.clientPresenceTtlSeconds = this.readPositiveInt('CLIENT_PRESENCE_TTL_SECONDS', CLIENT_PRESENCE_TTL_SECONDS);
    }

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

    public async setClientPresence(presence: ClientPresence): Promise<void> {
        if (!await this.ensureConnected()) {
            return;
        }

        const serialized = JSON.stringify({
            ...presence,
            userAgent: presence.userAgent ?? null,
            hashRate: Number.isFinite(Number(presence.hashRate)) ? Number(presence.hashRate) : 0,
            bestDifficulty: Number.isFinite(Number(presence.bestDifficulty)) ? Number(presence.bestDifficulty) : 0,
        });

        await Promise.all([
            this.publisher.setEx(clientPresenceKey(presence.clientId), this.clientPresenceTtlSeconds, serialized),
            this.publisher.sAdd(CLIENT_PRESENCE_ALL_KEY, presence.clientId),
            this.publisher.sAdd(clientPresenceAddressKey(presence.address), presence.clientId),
        ]);
    }

    public async removeClientPresence(clientId: string, address?: string): Promise<void> {
        if (!await this.ensureConnected()) {
            return;
        }

        let resolvedAddress = address;
        if (resolvedAddress == null) {
            const presence = await this.getClientPresence(clientId);
            resolvedAddress = presence?.address;
        }

        const removals: Promise<unknown>[] = [
            this.publisher.del(clientPresenceKey(clientId)),
            this.publisher.sRem(CLIENT_PRESENCE_ALL_KEY, clientId),
        ];
        if (resolvedAddress != null) {
            removals.push(this.publisher.sRem(clientPresenceAddressKey(resolvedAddress), clientId));
        }

        await Promise.all(removals);
    }

    public async getClientPresence(clientId: string): Promise<ClientPresence | null> {
        if (!await this.ensureConnected()) {
            return null;
        }

        const value = await this.publisher.get(clientPresenceKey(clientId));
        return this.parseClientPresence(value);
    }

    public async getClientPresenceByAddress(address: string): Promise<ClientPresence[]> {
        if (!await this.ensureConnected()) {
            return [];
        }

        return this.getPresenceFromSet(clientPresenceAddressKey(address));
    }

    public async getAllClientPresence(): Promise<ClientPresence[]> {
        if (!await this.ensureConnected()) {
            return [];
        }

        return this.getPresenceFromSet(CLIENT_PRESENCE_ALL_KEY);
    }

    public async clearClientPresence(): Promise<void> {
        if (!await this.ensureConnected()) {
            return;
        }

        const batch: string[] = [];
        for await (const keyOrKeys of (this.publisher as any).scanIterator({ MATCH: 'client-presence*', COUNT: 1000 })) {
            const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
            batch.push(...keys.map(key => key as string));
            if (batch.length >= 500) {
                await this.deleteKeys(batch.splice(0));
            }
        }

        await this.deleteKeys(batch);
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

    private async getPresenceFromSet(setKey: string): Promise<ClientPresence[]> {
        const clientIds = await this.publisher.sMembers(setKey);
        if (clientIds.length === 0) {
            return [];
        }

        const presences: ClientPresence[] = [];
        const staleClientIds: string[] = [];
        for (let i = 0; i < clientIds.length; i += 1000) {
            const chunk = clientIds.slice(i, i + 1000);
            const values = await this.publisher.mGet(chunk.map(clientPresenceKey));
            values.forEach((value, index) => {
                const presence = this.parseClientPresence(value);
                if (presence == null) {
                    staleClientIds.push(chunk[index]);
                    return;
                }
                presences.push(presence);
            });
        }

        for (let i = 0; i < staleClientIds.length; i += 1000) {
            const staleChunk = staleClientIds.slice(i, i + 1000);
            if (staleChunk.length === 0) {
                continue;
            }
            await this.publisher.sRem(setKey, staleChunk);
            if (setKey !== CLIENT_PRESENCE_ALL_KEY) {
                await this.publisher.sRem(CLIENT_PRESENCE_ALL_KEY, staleChunk);
            }
        }

        return presences;
    }

    private parseClientPresence(value: unknown): ClientPresence | null {
        if (value == null) {
            return null;
        }

        try {
            const parsed = JSON.parse(value as string);
            if (parsed?.clientId == null || parsed?.address == null) {
                return null;
            }
            return {
                clientId: parsed.clientId,
                address: parsed.address,
                clientName: parsed.clientName ?? 'default',
                sessionId: parsed.sessionId ?? parsed.clientId,
                userAgent: parsed.userAgent ?? null,
                startTime: parsed.startTime,
                lastSeen: parsed.lastSeen,
                hashRate: Number(parsed.hashRate ?? 0),
                bestDifficulty: Number(parsed.bestDifficulty ?? 0),
            };
        } catch (error) {
            console.error(`Invalid Redis client presence: ${error.message}`);
            return null;
        }
    }

    private readPositiveInt(name: string, defaultValue: number): number {
        const value = Number(this.configService.get<string>(name) ?? process.env[name]);
        return Number.isInteger(value) && value > 0 ? value : defaultValue;
    }

    private async deleteKeys(keys: string[]): Promise<void> {
        if (keys.length === 0) {
            return;
        }
        await (this.publisher as any).del(...keys);
    }
}
