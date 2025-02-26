import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RPCClient } from 'rpc-bitcoin';
import { asyncScheduler, BehaviorSubject, delay, filter, from, interval, scheduled, shareReplay, startWith, Subject, switchMap } from 'rxjs';
import { RpcBlockService } from 'src/ORM/rpc-block/rpc-block.service';
import * as zmq from 'zeromq';

import { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { IMiningInfo } from '../models/bitcoin-rpc/IMiningInfo';
import * as PGPubsub from 'pg-pubsub';

@Injectable()
export class BitcoinRpcService implements OnModuleInit {

    
    private client: RPCClient;
    private _newBlockTemplate$: BehaviorSubject<IBlockTemplate> = new BehaviorSubject(undefined);
    private pubsubInstance: PGPubsub;
    private resetTemplateInterval$ = new Subject<void>();

    public miningInfo: IMiningInfo;
    public newBlockTemplate$ = this._newBlockTemplate$.pipe(filter(block => block != null), shareReplay({ refCount: true, bufferSize: 1 }));

    constructor(
        private readonly configService: ConfigService,
        private rpcBlockService: RpcBlockService
    ) {

    }

    async onModuleInit() {

        this.pubsubInstance = new PGPubsub('postgres://' + this.configService.get('DB_USERNAME') + ':' + this.configService.get('DB_PASSWORD') + '@' + this.configService.get('DB_HOST') + ':' + this.configService.get('DB_PORT') + '/' + this.configService.get('DB_DATABASE'))


        const url = this.configService.get('BITCOIN_RPC_URL');
        const user = this.configService.get('BITCOIN_RPC_USER');
        const pass = this.configService.get('BITCOIN_RPC_PASSWORD');
        const port = parseInt(this.configService.get('BITCOIN_RPC_PORT'));
        const timeout = parseInt(this.configService.get('BITCOIN_RPC_TIMEOUT'));

        this.client = new RPCClient({ url, port, timeout, user, pass });

        this.client.getrpcinfo().then((res) => {
            console.log('Bitcoin RPC connected');
        }, () => {
            console.error('Could not reach RPC host');
        });
        
        this.miningInfo = await this.getMiningInfo();

        console.log(`MASTER? ${process.env.MASTER}`)
        if (process.env.MASTER != 'true') {
            this.pubsubInstance.addChannel('miningInfo', async (miningInfo: IMiningInfo) => {
                //console.log('PG Sub. new template');
                this.miningInfo = miningInfo;
                const savedBlockTemplate = await this.rpcBlockService.getSavedBlockTemplate(miningInfo.blocks);
                this._newBlockTemplate$.next(JSON.parse(savedBlockTemplate.data));
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
        await this.pubsubInstance.publish('miningInfo', this.miningInfo);
    }

    private async loadBlockTemplate(blockHeight: number) {

        console.log(`Master fetching block template ${blockHeight}`);

        let blockTemplate: IBlockTemplate;
        while (blockTemplate == null) {
            blockTemplate = await this.client.getblocktemplate({
                template_request: {
                    rules: ['segwit'],
                    mode: 'template',
                    capabilities: ['serverlist', 'proposal']
                }
            });
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
            return await this.client.getmininginfo();
        } catch (e) {
            console.error('Error getmininginfo', e.message);
            return null;
        }

    }

    public async SUBMIT_BLOCK(hexdata: string): Promise<string> {
        let response: string = 'unknown';
        try {
            response = await this.client.submitblock({
                hexdata
            });
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
}

