import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RPCClient } from 'rpc-bitcoin';
import { BehaviorSubject, filter, shareReplay } from 'rxjs';
import { RpcBlockService } from 'src/ORM/rpc-block/rpc-block.service';
import * as zmq from 'zeromq';

import { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { IMiningInfo } from '../models/bitcoin-rpc/IMiningInfo';

@Injectable()
export class BitcoinRpcService implements OnModuleInit {

    private blockHeight = 0;
    private client: RPCClient;
    private _newBlock$: BehaviorSubject<IMiningInfo> = new BehaviorSubject(undefined);
    public newBlock$ = this._newBlock$.pipe(filter(block => block != null), shareReplay({ refCount: true, bufferSize: 1 }));

    constructor(
        private readonly configService: ConfigService,
        private rpcBlockService: RpcBlockService
    ) {
    }

    async onModuleInit() {
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

        if (this.configService.get('BITCOIN_ZMQ_HOST')) {
            console.log('Using ZMQ');
            const sock = new zmq.Subscriber;


            sock.connectTimeout = 1000;
            sock.events.on('connect', () => {
                console.log('ZMQ Connected');
            });
            sock.events.on('connect:retry', () => {
                console.log('ZMQ Unable to connect, Retrying');
            });

            sock.connect(this.configService.get('BITCOIN_ZMQ_HOST'));
            sock.subscribe('rawblock');
            // Don't await this, otherwise it will block the rest of the program
            this.listenForNewBlocks(sock);
            await this.pollMiningInfo();

        } else {
            setInterval(this.pollMiningInfo.bind(this), 500);
        }
    }

    private async listenForNewBlocks(sock: zmq.Subscriber) {
        for await (const [topic, msg] of sock) {
            console.log("New Block");
            await this.pollMiningInfo();
        }
    }

    public async pollMiningInfo() {
        const miningInfo = await this.getMiningInfo();
        if (miningInfo != null && miningInfo.blocks > this.blockHeight) {
            console.log("block height change");
            this._newBlock$.next(miningInfo);
            this.blockHeight = miningInfo.blocks;
        }
    }

    private async waitForBlock(blockHeight: number): Promise<IBlockTemplate> {
        while (true) {
            await new Promise(r => setTimeout(r, 100));

            const block = await this.rpcBlockService.getBlock(blockHeight);
            if (block != null && block.data != null) {
                console.log('promise loop resolved');
                return Promise.resolve(JSON.parse(block.data));
            }
            console.log('promise loop');
        }
    }

    public async getBlockTemplate(blockHeight: number): Promise<IBlockTemplate> {
        let result: IBlockTemplate;
        try {

            const block = await this.rpcBlockService.getBlock(blockHeight);

            if (block != null && block.data != null) {
                return Promise.resolve(JSON.parse(block.data));
            } else if (block == null) {

                if (process.env.NODE_APP_INSTANCE != null) {
                    // There is a unique constraint on the block height so if another process tries to lock, it'll throw
                    try {
                        await this.rpcBlockService.lockBlock(blockHeight, process.env.NODE_APP_INSTANCE);
                    } catch (e) {
                        result = await this.waitForBlock(blockHeight);
                    }
                }

                result = await this.client.getblocktemplate({
                    template_request: {
                        rules: ['segwit'],
                        mode: 'template',
                        capabilities: ['serverlist', 'proposal']
                    }
                });
                await this.rpcBlockService.saveBlock(blockHeight, JSON.stringify(result));

            } else {
                //wait for block
                result = await this.waitForBlock(blockHeight);

            }



        } catch (e) {
            console.error('Error getblocktemplate:', e.message);
            throw new Error('Error getblocktemplate');
        }
        console.log(`getblocktemplate tx count: ${result.transactions.length}`);
        return result;
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

