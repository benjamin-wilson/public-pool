import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';

import { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { IMiningInfo } from '../models/bitcoin-rpc/IMiningInfo';
import { PayoutMode } from '../types/payout-mode';

const MINING_INFO_CHANNEL = 'mining-info.updated';
const BLOCK_TEMPLATE_CHANNEL = 'block-template.updated';
const SV1_BRIDGE_CHANNEL = 'sv1-bridge.updated';
const SV1_PRESTAGE_ACTIVATION_CHANNEL = 'sv1-prestage.activate';
const SV1_PRESTAGE_CHANNEL = 'sv1-prestage.updated';
const BLOCK_FOUND_NOTIFICATION_CHANNEL = 'block-found.notification';
const MINING_INFO_KEY = 'mining-info:latest';
const BLOCK_TEMPLATE_LATEST_KEY = 'block-template:latest';
const SV1_BRIDGE_LATEST_KEY = 'sv1-bridge:latest';
const SV1_PRESTAGE_LATEST_KEY = 'sv1-prestage:latest';
const BLOCK_TEMPLATE_CACHE_TTL_SECONDS = 60 * 60;
const sv1BridgeLatestKey = (payoutMode: PayoutMode) =>
    `${SV1_BRIDGE_LATEST_KEY}:${payoutMode}`;
const sv1PrestageLatestKey = (payoutMode: PayoutMode) =>
    `${SV1_PRESTAGE_LATEST_KEY}:${payoutMode}`;
const blockTemplateLegacyKey = (height: number) => `block-template:${height}`;
const blockTemplateKey = (
    height: number,
    previousBlockHash: string,
    payoutMode: PayoutMode,
) => `block-template:${height}:${previousBlockHash}:${payoutMode}`;
const blockTemplateHeightPointerKey = (height: number, payoutMode: PayoutMode) =>
    `block-template:${height}:${payoutMode}:latest`;
const blockTemplateLatestPointerKey = (payoutMode: PayoutMode) =>
    `${BLOCK_TEMPLATE_LATEST_KEY}:${payoutMode}`;
const jsonCacheKey = (key: string) => `json-cache:${key}`;
const jsonCacheLockKey = (key: string) => `json-cache-lock:${key}`;

export interface BlockTemplateUpdate {
    schemaVersion: 1;
    eventId: string;
    height: number;
    previousBlockHash: string;
    payoutMode: PayoutMode;
    publishedAtMs: number;
}

export interface Sv1BridgeUpdate {
    schemaVersion: 1;
    type: 'subsidy-bridge';
    eventId: string;
    template: IBlockTemplate;
    publishedAtMs: number;
    /** Local worker timestamp; populated after Redis delivery, never serialized by the master. */
    workerReceivedAtMs?: number;
}

export interface Sv1PrestageUpdate {
    schemaVersion: 1;
    type: 'subsidy-prestage';
    eventId: string;
    template: IBlockTemplate;
    preparedAtMs: number;
}

/**
 * Header-only activation for work whose coinbase and notify buffers were
 * prepared during the prior height. Every field comes from an authoritative
 * GBT; no next-block consensus field is inferred from ZMQ.
 */
export interface Sv1PrestageActivation {
    schemaVersion: 1;
    type: 'prestage-activation';
    eventId: string;
    height: number;
    previousBlockHash: string;
    version: number;
    bits: string;
    minTime: number;
    currentTime: number;
    subsidySats: number;
    payoutMode: PayoutMode;
    payoutSnapshotId?: string;
    requiredVersionBits: number;
    sourceNotificationReceivedAtMs?: number;
    publishedAtMs: number;
    /** Local worker timestamp; populated after Redis delivery. */
    workerReceivedAtMs?: number;
}

export interface BlockFoundNotification {
    schemaVersion: 1;
    eventId: string;
    address: string;
    height: number;
    blockHash: string;
    message: string;
    publishedAtMs: number;
}

@Injectable()
export class RedisMessagingService implements OnModuleInit, OnModuleDestroy {
    private publisher: RedisClientType;
    private subscriber: RedisClientType;
    /** Dedicated command socket so full-template writes cannot queue ahead of a new-tip bridge. */
    private urgentPublisher: RedisClientType;
    /** Dedicated Pub/Sub socket so canonical/replay callbacks cannot delay bridge receipt. */
    private urgentSubscriber: RedisClientType;
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
            this.urgentPublisher?.quit().catch(() => undefined),
            this.urgentSubscriber?.quit().catch(() => undefined),
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
        this.urgentPublisher = createClient({ url, socket });
        this.urgentSubscriber = createClient({ url, socket });

        this.publisher.on('error', error => console.error(`Redis publisher error: ${error.message}`));
        this.subscriber.on('error', error => console.error(`Redis subscriber error: ${error.message}`));
        this.urgentPublisher.on('error', error => console.error(`Redis urgent publisher error: ${error.message}`));
        this.urgentSubscriber.on('error', error => console.error(`Redis urgent subscriber error: ${error.message}`));
        this.publisher.on('end', () => { this.connected = false; });
        this.subscriber.on('end', () => { this.connected = false; });
        this.urgentPublisher.on('end', () => { this.connected = false; });
        this.urgentSubscriber.on('end', () => { this.connected = false; });

        await Promise.all([
            this.publisher.connect(),
            this.subscriber.connect(),
            this.urgentPublisher.connect(),
            this.urgentSubscriber.connect(),
        ]);
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

    public async publishBlockTemplateUpdate(update: BlockTemplateUpdate): Promise<void> {
        if (!await this.ensureConnected()) {
            return;
        }
        await this.publisher.publish(BLOCK_TEMPLATE_CHANNEL, JSON.stringify(update));
    }

    public async subscribeBlockTemplateUpdates(handler: (update: BlockTemplateUpdate) => Promise<void>): Promise<void> {
        if (!await this.ensureConnected()) {
            return;
        }
        await this.subscriber.subscribe(BLOCK_TEMPLATE_CHANNEL, async message => {
            try {
                const update = JSON.parse(message) as Partial<BlockTemplateUpdate>;
                if (update.schemaVersion !== 1
                    || !Number.isInteger(update.height)
                    || typeof update.eventId !== 'string'
                    || typeof update.previousBlockHash !== 'string'
                    || (update.payoutMode !== 'solo' && update.payoutMode !== 'pplns')) {
                    throw new Error('unsupported block template update');
                }
                await handler(update as BlockTemplateUpdate);
            } catch (error) {
                console.error(`Invalid Redis block template update: ${error.message}`);
            }
        });
    }

    public async publishBlockFoundNotification(notification: BlockFoundNotification): Promise<boolean> {
        if (!await this.ensureConnected()) {
            return false;
        }
        const serialized = JSON.stringify(notification);
        const validated = this.parseBlockFoundNotification(serialized);
        await this.publisher.publish(BLOCK_FOUND_NOTIFICATION_CHANNEL, JSON.stringify(validated));
        return true;
    }

    public async subscribeBlockFoundNotifications(
        handler: (notification: BlockFoundNotification) => Promise<void>,
    ): Promise<void> {
        if (!await this.ensureConnected()) {
            return;
        }
        await this.subscriber.subscribe(BLOCK_FOUND_NOTIFICATION_CHANNEL, async message => {
            try {
                await handler(this.parseBlockFoundNotification(message));
            } catch (error) {
                console.error(`Invalid Redis block found notification: ${error.message}`);
            }
        });
    }

    public async publishSv1BridgeUpdate(
        update: Sv1BridgeUpdate,
        lane: 'urgent' | 'fallback' = 'urgent',
    ): Promise<boolean> {
        if (!await this.ensureConnected()) {
            return false;
        }
        const serialized = JSON.stringify(update);
        const validated = this.parseSv1BridgeUpdate(serialized);
        const payoutMode = validated.template.payoutMode === 'pplns' ? 'pplns' : 'solo';
        // The bridge envelope is self-contained. Deliver it before spending a
        // second Redis round trip on best-effort replay metadata.
        const publisher = lane === 'urgent' ? this.urgentPublisher : this.publisher;
        await publisher.publish(SV1_BRIDGE_CHANNEL, serialized);
        void Promise.all([
            this.publisher.setEx(
                sv1BridgeLatestKey(payoutMode),
                BLOCK_TEMPLATE_CACHE_TTL_SECONDS,
                serialized,
            ),
            ...(payoutMode === 'solo'
                ? [this.publisher.setEx(
                    SV1_BRIDGE_LATEST_KEY,
                    BLOCK_TEMPLATE_CACHE_TTL_SECONDS,
                    serialized,
                )]
                : []),
        ]).catch(error => {
            console.error(`Unable to cache latest SV1 bridge: ${error.message}`);
        });
        return true;
    }

    public async publishSv1PrestageActivation(
        activation: Sv1PrestageActivation,
        lane: 'urgent' | 'fallback' = 'urgent',
    ): Promise<boolean> {
        if (!await this.ensureConnected()) {
            return false;
        }
        const serialized = JSON.stringify(activation);
        this.parseSv1PrestageActivation(serialized);
        const publisher = lane === 'urgent' ? this.urgentPublisher : this.publisher;
        await publisher.publish(SV1_PRESTAGE_ACTIVATION_CHANNEL, serialized);
        return true;
    }

    public async subscribeSv1PrestageActivations(
        handler: (activation: Sv1PrestageActivation) => Promise<void>,
    ): Promise<void> {
        if (!await this.ensureConnected()) {
            return;
        }
        await this.urgentSubscriber.subscribe(
            SV1_PRESTAGE_ACTIVATION_CHANNEL,
            async message => {
                try {
                    const activation = this.parseSv1PrestageActivation(message);
                    activation.workerReceivedAtMs = Date.now();
                    await handler(activation);
                } catch (error) {
                    console.error(`Invalid Redis SV1 prestage activation: ${error.message}`);
                }
            },
        );
    }

    public async subscribeSv1BridgeUpdates(handler: (update: Sv1BridgeUpdate) => Promise<void>): Promise<void> {
        if (!await this.ensureConnected()) {
            return;
        }
        await this.urgentSubscriber.subscribe(SV1_BRIDGE_CHANNEL, async message => {
            try {
                const update = this.parseSv1BridgeUpdate(message);
                update.workerReceivedAtMs = Date.now();
                await handler(update);
            } catch (error) {
                console.error(`Invalid Redis SV1 bridge update: ${error.message}`);
            }
        });
    }

    public async getLatestSv1BridgeUpdate(
        payoutMode: PayoutMode = 'solo',
    ): Promise<Sv1BridgeUpdate | null> {
        if (!await this.ensureConnected()) {
            return null;
        }
        let value = await this.publisher.get(sv1BridgeLatestKey(payoutMode)) as string | null;
        if (value == null && payoutMode === 'solo') {
            // Backward-compatible replay for solo bridges published before
            // latest pointers were split by payout mode.
            value = await this.publisher.get(SV1_BRIDGE_LATEST_KEY) as string | null;
        }
        if (value == null) {
            return null;
        }
        try {
            const update = this.parseSv1BridgeUpdate(value);
            return update.template.payoutMode === payoutMode ? update : null;
        } catch (error) {
            console.error(`Invalid Redis latest SV1 bridge update: ${error.message}`);
            return null;
        }
    }

    public async publishSv1PrestageUpdate(update: Sv1PrestageUpdate): Promise<void> {
        if (!await this.ensureConnected()) {
            return;
        }
        const serialized = JSON.stringify(update);
        const validated = this.parseSv1PrestageUpdate(serialized);
        const payoutMode = validated.template.payoutMode === 'pplns' ? 'pplns' : 'solo';
        await Promise.all([
            // Keep the current next-height seed until it is replaced. A Bitcoin
            // block interval can exceed the canonical-template cache TTL, and a
            // worker restart late in that interval must still be able to stage.
            this.publisher.set(
                sv1PrestageLatestKey(payoutMode),
                serialized,
            ),
            this.publisher.publish(SV1_PRESTAGE_CHANNEL, serialized),
        ]);
    }

    public async subscribeSv1PrestageUpdates(
        handler: (update: Sv1PrestageUpdate) => Promise<void>,
    ): Promise<void> {
        if (!await this.ensureConnected()) {
            return;
        }
        await this.subscriber.subscribe(SV1_PRESTAGE_CHANNEL, async message => {
            try {
                await handler(this.parseSv1PrestageUpdate(message));
            } catch (error) {
                console.error(`Invalid Redis SV1 prestage update: ${error.message}`);
            }
        });
    }

    public async getLatestSv1PrestageUpdates(): Promise<Sv1PrestageUpdate[]> {
        if (!await this.ensureConnected()) {
            return [];
        }
        const values = await this.publisher.mGet([
            sv1PrestageLatestKey('solo'),
            sv1PrestageLatestKey('pplns'),
        ]) as Array<string | null>;
        return values
            .filter((value): value is string => value != null)
            .map(value => this.parseSv1PrestageUpdate(value));
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

    public async setBlockTemplate(height: number, blockTemplate: IBlockTemplate): Promise<string | null> {
        if (!await this.ensureConnected()) {
            return null;
        }
        const payoutMode = blockTemplate.payoutMode === 'pplns' ? 'pplns' : 'solo';
        const key = blockTemplateKey(height, blockTemplate.previousblockhash, payoutMode);
        const serialized = JSON.stringify(blockTemplate);
        await Promise.all([
            this.publisher.setEx(key, BLOCK_TEMPLATE_CACHE_TTL_SECONDS, serialized),
            this.publisher.setEx(
                blockTemplateHeightPointerKey(height, payoutMode),
                BLOCK_TEMPLATE_CACHE_TTL_SECONDS,
                key,
            ),
            this.publisher.set(blockTemplateLatestPointerKey(payoutMode), key),
        ]);
        return key;
    }

    /**
     * Write the payload shape understood by pre-channel workers. Call this only
     * once the PPLNS-safe compatibility template is ready, then publish the
     * mining-info notification that wakes those workers.
     */
    public async setLegacyBlockTemplate(height: number, blockTemplate: IBlockTemplate): Promise<void> {
        if (!await this.ensureConnected()) {
            return;
        }
        const serialized = JSON.stringify(blockTemplate);
        await Promise.all([
            this.publisher.setEx(blockTemplateLegacyKey(height), 15 * 60, serialized),
            // Old workers JSON.parse this key directly, so it must remain a
            // template payload rather than one of the new pointer values.
            this.publisher.set(BLOCK_TEMPLATE_LATEST_KEY, serialized),
        ]);
    }

    public async getBlockTemplate(
        height: number,
        payoutMode: PayoutMode = 'solo',
        previousBlockHash?: string,
    ): Promise<IBlockTemplate | null> {
        if (!await this.ensureConnected()) {
            return null;
        }
        if (previousBlockHash != null) {
            return this.readBlockTemplateValue(
                await this.publisher.get(blockTemplateKey(height, previousBlockHash, payoutMode)) as string | null,
            );
        }

        const pointer = await this.publisher.get(blockTemplateHeightPointerKey(height, payoutMode)) as string | null;
        const pointedTemplate = await this.readBlockTemplatePointer(pointer);
        if (pointedTemplate != null) {
            return pointedTemplate;
        }

        // Backward-compatible replay for templates written before tip-specific keys.
        const legacyTemplate = this.readBlockTemplateValue(
            await this.publisher.get(blockTemplateLegacyKey(height)) as string | null,
        );
        return this.matchesPayoutMode(legacyTemplate, payoutMode)
            ? legacyTemplate
            : null;
    }

    public async getLatestBlockTemplate(payoutMode: PayoutMode = 'solo'): Promise<IBlockTemplate | null> {
        if (!await this.ensureConnected()) {
            return null;
        }
        const modeValue = await this.publisher.get(blockTemplateLatestPointerKey(payoutMode)) as string | null;
        if (modeValue != null) {
            return this.readBlockTemplatePointer(modeValue);
        }

        const value = await this.publisher.get(BLOCK_TEMPLATE_LATEST_KEY) as string | null;
        if (value == null) {
            return null;
        }
        if (/^\d+$/.test(value as string)) {
            return this.getBlockTemplate(Number(value), payoutMode);
        }
        const legacyTemplate = await this.readBlockTemplatePointer(value);
        return this.matchesPayoutMode(legacyTemplate, payoutMode)
            ? legacyTemplate
            : null;
    }

    public async getLatestBlockTemplates(): Promise<IBlockTemplate[]> {
        const [solo, pplns] = await Promise.all([
            this.getLatestBlockTemplate('solo'),
            this.getLatestBlockTemplate('pplns'),
        ]);
        return [solo, pplns].filter((template): template is IBlockTemplate => template != null);
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

    public async tryAcquireJsonCacheLock(key: string, owner: string, ttlMs: number): Promise<boolean | null> {
        if (!await this.ensureConnected()) {
            return null;
        }
        if (owner.length === 0 || ttlMs <= 0) {
            return false;
        }

        const result = await this.publisher.set(
            jsonCacheLockKey(key),
            owner,
            { NX: true, PX: Math.max(1, Math.ceil(ttlMs)) },
        );
        return result === 'OK';
    }

    public async releaseJsonCacheLock(key: string, owner: string): Promise<void> {
        if (!await this.ensureConnected() || owner.length === 0) {
            return;
        }

        await this.publisher.eval(
            `
                if redis.call('GET', KEYS[1]) == ARGV[1] then
                    return redis.call('DEL', KEYS[1])
                end
                return 0
            `,
            {
                keys: [jsonCacheLockKey(key)],
                arguments: [owner],
            },
        );
    }

    private async readBlockTemplatePointer(value: string | null): Promise<IBlockTemplate | null> {
        if (value == null) {
            return null;
        }
        if (value.startsWith('block-template:')) {
            return this.readBlockTemplateValue(await this.publisher.get(value) as string | null);
        }
        return this.readBlockTemplateValue(value);
    }

    private readBlockTemplateValue(value: string | null): IBlockTemplate | null {
        if (value == null) {
            return null;
        }
        try {
            const parsed = JSON.parse(value) as IBlockTemplate;
            return parsed != null && typeof parsed === 'object' ? parsed : null;
        } catch (error) {
            console.error(`Invalid Redis block template: ${error.message}`);
            return null;
        }
    }

    private matchesPayoutMode(
        template: IBlockTemplate | null,
        payoutMode: PayoutMode,
    ): template is IBlockTemplate {
        return template != null
            && (template.payoutMode == null
                || template.payoutMode === 'all'
                || template.payoutMode === payoutMode);
    }

    private parseSv1BridgeUpdate(message: string): Sv1BridgeUpdate {
        const update = JSON.parse(message) as Partial<Sv1BridgeUpdate>;
        const template = update.template as Partial<IBlockTemplate> | undefined;
        const payoutMode = template?.payoutMode;
        const payoutOutputs = template?.payoutOutputs;
        const hasExplicitPplnsPayout = payoutMode !== 'pplns' || (
            typeof template?.payoutSnapshotId === 'string'
            && template.payoutSnapshotId.trim().length > 0
            && Array.isArray(payoutOutputs)
            && payoutOutputs.length > 0
            && Number.isSafeInteger(template.coinbasevalue)
            && payoutOutputs.every(output => (
                typeof output.address === 'string'
                && output.address.trim().length > 0
                && Number.isSafeInteger(output.amountSats)
                && output.amountSats >= 0
            ))
            && payoutOutputs.reduce((sum, output) => sum + output.amountSats, 0)
                === template.coinbasevalue
        );
        if (update.schemaVersion !== 1
            || update.type !== 'subsidy-bridge'
            || typeof update.eventId !== 'string'
            || template?.jobType !== 'empty'
            || (payoutMode !== 'solo' && payoutMode !== 'pplns')
            || !Array.isArray(template?.transactions)
            || template.transactions.length !== 0
            || typeof template.previousblockhash !== 'string'
            || !Number.isInteger(template.height)
            || !hasExplicitPplnsPayout) {
            throw new Error('unsupported SV1 bridge update');
        }
        return update as Sv1BridgeUpdate;
    }

    private parseSv1PrestageUpdate(message: string): Sv1PrestageUpdate {
        const update = JSON.parse(message) as Partial<Sv1PrestageUpdate>;
        const template = update.template as Partial<IBlockTemplate> | undefined;
        const payoutMode = template?.payoutMode;
        const payoutOutputs = template?.payoutOutputs;
        const hasExplicitPplnsPayout = payoutMode !== 'pplns' || (
            typeof template?.payoutSnapshotId === 'string'
            && template.payoutSnapshotId.trim().length > 0
            && Array.isArray(payoutOutputs)
            && payoutOutputs.length > 0
            && Number.isSafeInteger(template.coinbasevalue)
            && payoutOutputs.every(output => (
                typeof output.address === 'string'
                && output.address.trim().length > 0
                && Number.isSafeInteger(output.amountSats)
                && output.amountSats >= 0
            ))
            && payoutOutputs.reduce((sum, output) => sum + output.amountSats, 0)
                === template.coinbasevalue
        );
        if (update.schemaVersion !== 1
            || update.type !== 'subsidy-prestage'
            || typeof update.eventId !== 'string'
            || !Number.isFinite(update.preparedAtMs)
            || template?.jobType !== 'empty'
            || (payoutMode !== 'solo' && payoutMode !== 'pplns')
            || !Array.isArray(template?.transactions)
            || template.transactions.length !== 0
            || template.previousblockhash !== '0'.repeat(64)
            || !Number.isInteger(template.height)
            || !hasExplicitPplnsPayout) {
            throw new Error('unsupported SV1 prestage update');
        }
        return update as Sv1PrestageUpdate;
    }

    private parseSv1PrestageActivation(message: string): Sv1PrestageActivation {
        const activation = JSON.parse(message) as Partial<Sv1PrestageActivation>;
        const payoutMode = activation.payoutMode;
        const hasValidPayoutIdentity = payoutMode === 'solo'
            ? activation.payoutSnapshotId == null
            : typeof activation.payoutSnapshotId === 'string'
                && activation.payoutSnapshotId.trim().length > 0;
        if (activation.schemaVersion !== 1
            || activation.type !== 'prestage-activation'
            || typeof activation.eventId !== 'string'
            || activation.eventId.trim().length === 0
            || !Number.isSafeInteger(activation.height)
            || activation.height < 0
            || typeof activation.previousBlockHash !== 'string'
            || !/^[0-9a-f]{64}$/.test(activation.previousBlockHash)
            || !Number.isInteger(activation.version)
            || activation.version < -0x80000000
            || activation.version > 0x7fffffff
            || typeof activation.bits !== 'string'
            || !/^[0-9a-f]{8}$/.test(activation.bits)
            || !Number.isSafeInteger(activation.minTime)
            || !Number.isSafeInteger(activation.currentTime)
            || !Number.isSafeInteger(activation.subsidySats)
            || activation.subsidySats < 0
            || (payoutMode !== 'solo' && payoutMode !== 'pplns')
            || !hasValidPayoutIdentity
            || !Number.isInteger(activation.requiredVersionBits)
            || activation.requiredVersionBits < 0
            || activation.requiredVersionBits > 0xffffffff
            || !Number.isFinite(activation.publishedAtMs)) {
            throw new Error('unsupported SV1 prestage activation');
        }
        return activation as Sv1PrestageActivation;
    }

    private parseBlockFoundNotification(message: string): BlockFoundNotification {
        const notification = JSON.parse(message) as Partial<BlockFoundNotification>;
        if (notification.schemaVersion !== 1
            || typeof notification.eventId !== 'string'
            || notification.eventId.trim().length < 1
            || typeof notification.address !== 'string'
            || notification.address.trim().length < 1
            || !Number.isInteger(notification.height)
            || typeof notification.blockHash !== 'string'
            || notification.blockHash.trim().length < 1
            || typeof notification.message !== 'string'
            || !Number.isFinite(notification.publishedAtMs)) {
            throw new Error('unsupported block found notification');
        }
        return notification as BlockFoundNotification;
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
