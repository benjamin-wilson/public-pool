import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Server, Socket } from 'net';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientService } from '../ORM/client/client.service';
import { PayoutSnapshotService } from '../ORM/payout-snapshot/payout-snapshot.service';
import { ShareAccountingService } from '../ORM/share-accounting/share-accounting.service';
import { StratumV2Client } from '../models/StratumV2Client';
import { encodeSv2AuthorityPublicKey } from '../models/sv2/sv2-authority-key';
import { Sv2ExtranonceManager } from '../models/sv2/sv2-extranonce-manager';
import {
    createSignatureNoiseMessage,
    generateServerKeypair,
    Sv2NoiseConfig,
    Sv2ServerKeypair,
    xOnlyPubKeyFromPriv,
} from '../models/sv2/sv2-noise';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { CustomWorkService } from './custom-work.service';
import { NotificationService } from './notification.service';
import { RedisMessagingService } from './redis-messaging.service';
import { StratumV1JobsService } from './stratum-v1-jobs.service';
import { Sv2JobDeclarationRegistryService } from './sv2-job-declaration-registry.service';
import { parsePayoutModePorts, PayoutMode } from '../types/payout-mode';

const DEFAULT_SOCKET_TIMEOUT_MS = 1000 * 60 * 60;
const DEFAULT_TCP_KEEPALIVE_INITIAL_DELAY_MS = 1000 * 60;

@Injectable()
export class StratumV2Service implements OnModuleInit {
    private readonly servers: Server[] = [];
    private authorityPrivKey: Buffer;
    private authorityPublicKeyXOnly: Buffer;
    private authorityKeyConfigured = false;
    private serverKeypair: Sv2ServerKeypair;
    private noiseConfig: Sv2NoiseConfig;
    private channelIdCounter = 1;
    private readonly extranonceManager = new Sv2ExtranonceManager();

    constructor(
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly clientService: ClientService,
        private readonly notificationService: NotificationService,
        private readonly blocksService: BlocksService,
        private readonly configService: ConfigService,
        private readonly stratumV1JobsService: StratumV1JobsService,
        private readonly addressSettingsService: AddressSettingsService,
        private readonly customWorkService: CustomWorkService,
        private readonly jobDeclarationRegistry: Sv2JobDeclarationRegistryService,
        private readonly shareAccountingService?: ShareAccountingService,
        private readonly redisMessagingService?: RedisMessagingService,
        private readonly payoutSnapshotService?: PayoutSnapshotService,
    ) {}

    public async onModuleInit(): Promise<void> {
        if (process.env.API_ONLY === 'true') {
            console.log('API-only process skipping Stratum V2 socket listeners');
            return;
        }

        if (process.env.MASTER === 'true') {
            return;
        }

        const ports = this.getPorts();
        if (ports.length === 0) {
            return;
        }

        await this.ensureInitialized();
        ports.forEach(({ port, payoutMode }) => this.startSocketServer(port, payoutMode));
    }

    public async ensureInitialized(): Promise<void> {
        if (this.noiseConfig != null) {
            return;
        }

        await this.initializeNoiseConfig();
    }

    public createClient(socket: Socket, firstChunk: Buffer, payoutMode: PayoutMode = 'solo'): StratumV2Client {
        if (this.noiseConfig == null) {
            throw new Error('Stratum V2 service is not initialized');
        }

        return new StratumV2Client(
            socket,
            firstChunk,
            this,
            this.stratumV1JobsService,
            this.bitcoinRpcService,
            this.clientService,
            this.notificationService,
            this.blocksService,
            this.configService,
            this.addressSettingsService,
            this.customWorkService,
            this.jobDeclarationRegistry,
            this.shareAccountingService,
            this.redisMessagingService,
            this.payoutSnapshotService,
            payoutMode,
        );
    }

    public getNoiseConfig(): Sv2NoiseConfig {
        return this.noiseConfig;
    }

    public async getPoolAuthorityPublicKey(): Promise<{ publicKey: string; configured: boolean }> {
        await this.ensureInitialized();

        return {
            publicKey: encodeSv2AuthorityPublicKey(this.authorityPublicKeyXOnly),
            configured: this.authorityKeyConfigured,
        };
    }

    public getNextChannelId(): number {
        return this.channelIdCounter++;
    }

    public generateExtranoncePrefix(): Buffer {
        const prefix = Buffer.alloc(4);
        prefix.writeUInt16BE(this.channelIdCounter & 0xffff, 0);
        crypto.randomBytes(2).copy(prefix, 2);
        return prefix;
    }

    public allocateExtendedExtranoncePrefix(channelId: number): Buffer {
        return this.extranonceManager.allocate(channelId);
    }

    public releaseExtendedExtranoncePrefix(channelId: number): void {
        this.extranonceManager.release(channelId);
    }

    public getExtendedMinerExtranonceSize(): number {
        return this.extranonceManager.minerExtranonceSize;
    }

    public getExtendedTotalExtranonceSize(): number {
        return this.extranonceManager.totalSize;
    }

    private async initializeNoiseConfig(): Promise<void> {
        const configuredAuthorityKey = this.configService.get<string>('SV2_AUTHORITY_PRIVKEY');
        this.authorityKeyConfigured = configuredAuthorityKey?.length === 64;
        this.authorityPrivKey = configuredAuthorityKey?.length === 64
            ? Buffer.from(configuredAuthorityKey, 'hex')
            : crypto.randomBytes(32);
        this.authorityPublicKeyXOnly = xOnlyPubKeyFromPriv(this.authorityPrivKey);

        if (!configuredAuthorityKey) {
            console.warn('SV2_AUTHORITY_PRIVKEY is not set; generated an ephemeral SV2 authority key');
        }

        this.serverKeypair = await generateServerKeypair();
        const now = Math.floor(Date.now() / 1000);
        this.noiseConfig = {
            staticKeypair: this.serverKeypair,
            certificateMessage: createSignatureNoiseMessage(
                this.authorityPrivKey,
                xOnlyPubKeyFromPriv(this.serverKeypair.privateKey),
                now - 3600,
                now + 86400,
            ),
        };
    }

    private getPorts(): { port: number; payoutMode: PayoutMode }[] {
        return parsePayoutModePorts(
            this.configService.get<string>('STRATUM_V2_PORTS'),
            this.configService.get<string>('PPLNS_STRATUM_V2_PORTS'),
        );
    }

    private startSocketServer(port: number, payoutMode: PayoutMode): void {
        const server = new Server((socket: Socket) => {
            socket.setTimeout(this.getSocketTimeoutMs());
            socket.setKeepAlive(true, this.getTcpKeepAliveInitialDelayMs());
            socket.setNoDelay(true);

            let client: StratumV2Client = null;

            const closeSocket = () => {
                if (client != null) {
                    void client.destroy();
                }
                if (!socket.destroyed) {
                    socket.destroy();
                }
            };

            socket.once('data', (firstChunk: Buffer) => {
                client = this.createClient(socket, firstChunk, payoutMode);
            });

            socket.on('timeout', closeSocket);
            socket.on('error', (error: NodeJS.ErrnoException) => {
                if (error.code !== 'ECONNRESET') {
                    console.error(`Stratum V2 socket error: ${error.message}`);
                }
                closeSocket();
            });
            socket.on('close', () => {
                if (client != null) {
                    void client.destroy();
                }
            });
        });

        server.on('error', (error) => {
            console.error(`Stratum V2 server error on port ${port}: ${error.message}`);
        });

        server.listen(port, () => {
            console.log(`Stratum V2 ${payoutMode} server is listening on port ${port}`);
        });
        this.servers.push(server);
    }

    private getSocketTimeoutMs(): number {
        const configured = parseInt(
            this.configService.get<string>('STRATUM_V2_SOCKET_TIMEOUT_MS')
            ?? this.configService.get<string>('STRATUM_SOCKET_TIMEOUT_MS')
            ?? '',
            10,
        );
        return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SOCKET_TIMEOUT_MS;
    }

    private getTcpKeepAliveInitialDelayMs(): number {
        const configured = parseInt(
            this.configService.get<string>('STRATUM_TCP_KEEPALIVE_INITIAL_DELAY_MS')
            ?? '',
            10,
        );
        return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TCP_KEEPALIVE_INITIAL_DELAY_MS;
    }
}
