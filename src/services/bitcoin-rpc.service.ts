import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { asyncScheduler, BehaviorSubject, delay, filter, from, interval, scheduled, shareReplay, startWith, Subject, switchMap } from 'rxjs';
import { RpcBlockService } from '../ORM/rpc-block/rpc-block.service';
import * as zmq from 'zeromq';

import { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { IMiningInfo } from '../models/bitcoin-rpc/IMiningInfo';
import { RedisMessagingService } from './redis-messaging.service';

@Injectable()
export class BitcoinRpcService implements OnModuleInit {

    
    private client: AxiosInstance;
    private _newBlockTemplate$: BehaviorSubject<IBlockTemplate> = new BehaviorSubject(undefined);
    private resetTemplateInterval$ = new Subject<void>();
    private rpcRequestId = 0;

    public miningInfo: IMiningInfo;
    public newBlockTemplate$ = this._newBlockTemplate$.pipe(filter(block => block != null), shareReplay({ refCount: true, bufferSize: 1 }));

    constructor(
        private readonly configService: ConfigService,
        private rpcBlockService: RpcBlockService,
        private readonly redisMessagingService: RedisMessagingService
    ) {

    }

    async onModuleInit() {

        const url = this.configService.get('BITCOIN_RPC_URL');
        const user = this.configService.get('BITCOIN_RPC_USER');
        const pass = this.configService.get('BITCOIN_RPC_PASSWORD');
        const port = parseInt(this.configService.get('BITCOIN_RPC_PORT'));
        const timeout = parseInt(this.configService.get('BITCOIN_RPC_TIMEOUT'));

        const baseURL = this.buildRpcUrl(url, port);
        this.client = axios.create({
            baseURL,
            timeout,
            auth: {
                username: user,
                password: pass
            }
        });

        this.callRpc('getrpcinfo').then((res) => {
            console.log('Bitcoin RPC connected');
        }, () => {
            console.error('Could not reach RPC host');
        });
        
        this.miningInfo = await this.getMiningInfo();

        console.log(`MASTER? ${process.env.MASTER}`)
        if (process.env.MASTER != 'true') {
            await this.loadLatestTemplateForWorker();
            await this.redisMessagingService.subscribeMiningInfoUpdates(async (miningInfo: IMiningInfo) => {
                this.miningInfo = miningInfo;
                await this.loadTemplateForWorker(miningInfo.blocks);
            });
        } else {
            console.log('Using ZMQ');
            const sock = new zmq.Subscriber;

            sock.connectTimeout = 1000;
            sock.events.on('connect', () => {
                console.log('ZMQ Connected');
            });
            sock.events.on('connect:retry', () => {
                console.error('ZMQ Unable to connect, Retrying');
            });

            sock.connect(this.configService.get('BITCOIN_ZMQ_HOST'));
            sock.subscribe('rawblock');
            // Don't await this, otherwise it will block the rest of the program
            this.listenForNewBlocks(sock);

            // Between new blocks we want refresh jobs with the latest transactions
            this.resetTemplateInterval$.pipe(
                startWith(null),
                switchMap(() =>interval(60000))
            ).subscribe(async () =>{
                await this.getAndBroadcastLatestTemplate();
            });

        }

    }

    private async listenForNewBlocks(sock: zmq.Subscriber) {
        for await (const [topic, msg] of sock) {
            console.log("New Block");
            this.miningInfo = await this.getMiningInfo();
            await this.getAndBroadcastLatestTemplate();

            //Reset the block update interval
            this.resetTemplateInterval$.next();
        }
    }

    public async getAndBroadcastLatestTemplate() {
        const blockTemplate = await this.loadBlockTemplate(this.miningInfo.blocks);
        this._newBlockTemplate$.next(blockTemplate);
        await this.redisMessagingService.setLatestMiningInfo(this.miningInfo);
        await this.redisMessagingService.setBlockTemplate(this.miningInfo.blocks, blockTemplate);
        await this.redisMessagingService.publishMiningInfoUpdate(this.miningInfo);
    }

    private async loadLatestTemplateForWorker() {
        const latestMiningInfo = await this.redisMessagingService.getLatestMiningInfo();
        if (latestMiningInfo != null) {
            this.miningInfo = latestMiningInfo;
            await this.loadTemplateForWorker(latestMiningInfo.blocks);
            return;
        }

        const latestBlockTemplate = await this.redisMessagingService.getLatestBlockTemplate();
        if (latestBlockTemplate != null) {
            this._newBlockTemplate$.next(latestBlockTemplate);
        }
    }

    private async loadTemplateForWorker(blockHeight: number) {
        const redisBlockTemplate = await this.redisMessagingService.getBlockTemplate(blockHeight);
        if (redisBlockTemplate != null) {
            this._newBlockTemplate$.next(redisBlockTemplate);
            return;
        }

        const savedBlockTemplate = await this.rpcBlockService.getSavedBlockTemplate(blockHeight);
        if (savedBlockTemplate?.data != null) {
            this._newBlockTemplate$.next(JSON.parse(savedBlockTemplate.data));
        }
    }

    private async loadBlockTemplate(blockHeight: number) {

        console.log(`Master fetching block template ${blockHeight}`);

        let blockTemplate: IBlockTemplate;
        while (blockTemplate == null) {
            blockTemplate = await this.callRpc<IBlockTemplate>('getblocktemplate', [
                {
                    rules: ['segwit'],
                    mode: 'template',
                    capabilities: ['serverlist', 'proposal']
                }
            ]);
        }

        try {
            console.log(`Saving block ${blockHeight}`);
            await this.rpcBlockService.saveBlock(blockHeight, JSON.stringify(blockTemplate));
            console.log('block saved');
        } catch (e) {
            console.error('Error saving block', e);
        }

        return blockTemplate;
    }

    public async getMiningInfo(): Promise<IMiningInfo> {
        try {
            return await this.callRpc<IMiningInfo>('getmininginfo');
        } catch (e) {
            console.error('Error getmininginfo', e.message);
            return null;
        }

    }

    public async SUBMIT_BLOCK(hexdata: string): Promise<string> {
        let response: string = 'unknown';
        try {
            response = await this.callRpc<string>('submitblock', [hexdata]);
            if (response == null) {
                response = 'SUCCESS!';
            }
            console.log(`BLOCK SUBMISSION RESPONSE: ${response}`);
            console.log(hexdata);
            console.log(JSON.stringify(response));
        } catch (e) {
            response = e;
            console.log(`BLOCK SUBMISSION RESPONSE ERROR: ${e}`);
        }
        return response;

    }

    private async callRpc<T>(method: string, params: unknown[] = []): Promise<T> {
        const response = await this.client.post('', {
            jsonrpc: '1.0',
            id: ++this.rpcRequestId,
            method,
            params
        });

        if (response.data.error != null) {
            throw response.data.error;
        }

        return response.data.result;
    }

    private buildRpcUrl(url: string, port: number): string {
        const normalizedUrl = /^https?:\/\//i.test(url) ? url : `http://${url}`;
        const rpcUrl = new URL(normalizedUrl);
        if (Number.isFinite(port) && port > 0) {
            rpcUrl.port = port.toString();
        }
        return rpcUrl.toString();
    }
}
