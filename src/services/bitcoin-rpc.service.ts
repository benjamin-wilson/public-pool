import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as fs from 'node:fs';
import { BehaviorSubject, filter, shareReplay } from 'rxjs';
import * as zmq from 'zeromq';

import { RpcBlockService } from '../ORM/rpc-block/rpc-block.service';
import { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { IMiningInfo } from '../models/bitcoin-rpc/IMiningInfo';

@Injectable()
export class BitcoinRpcService implements OnModuleInit {

    private blockHeight = 0;
    private client: AxiosInstance;
    private rpcRequestId = 0;
    private _newBlock$: BehaviorSubject<IMiningInfo> = new BehaviorSubject(undefined);
    public newBlock$ = this._newBlock$.pipe(filter(block => block != null), shareReplay({ refCount: true, bufferSize: 1 }));

    constructor(
        private readonly configService: ConfigService,
        private rpcBlockService: RpcBlockService
    ) {
    }

    async onModuleInit() {
        const url = this.configService.get('BITCOIN_RPC_URL');
        let user = this.configService.get('BITCOIN_RPC_USER');
        let pass = this.configService.get('BITCOIN_RPC_PASSWORD');
        const port = parseInt(this.configService.get('BITCOIN_RPC_PORT'));
        const timeout = parseInt(this.configService.get('BITCOIN_RPC_TIMEOUT'));

        const cookiefile = this.configService.get('BITCOIN_RPC_COOKIEFILE');

        if (cookiefile != undefined && cookiefile != '') {
            const cookie = fs.readFileSync(cookiefile).toString().trim().split(':');

            user = cookie[0];
            pass = cookie[1];
        }

        const baseURL = this.buildRpcUrl(url, port);
        this.client = axios.create({
            baseURL,
            timeout,
            auth: {
                username: user,
                password: pass
            }
        });

        this.callRpc('getrpcinfo').then(() => {
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
                console.log(`promise loop resolved, block height ${blockHeight}`);
                return Promise.resolve(JSON.parse(block.data));
            }
            console.log(`promise loop, block height ${blockHeight}`);
        }
    }

    public async getBlockTemplate(blockHeight: number): Promise<IBlockTemplate> {
        let result: IBlockTemplate;
        try {
            const block = await this.rpcBlockService.getBlock(blockHeight);
            const completeBlock = block?.data != null;

            // If the block has already been loaded, and the same instance is fetching the template again, we just need to refresh it.
            if (completeBlock && block.lockedBy == process.env.NODE_APP_INSTANCE) {
                result = await this.loadBlockTemplate(blockHeight);
            }
            else if (completeBlock) {
                return Promise.resolve(JSON.parse(block.data));
            } else if (!completeBlock) {
                if (process.env.NODE_APP_INSTANCE != null) {
                    // There is a unique constraint on the block height so if another process tries to lock, it'll throw
                    try {
                        await this.rpcBlockService.lockBlock(blockHeight, process.env.NODE_APP_INSTANCE);
                    } catch (e) {
                        result = await this.waitForBlock(blockHeight);
                    }
                }
                result = await this.loadBlockTemplate(blockHeight);
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

    private async loadBlockTemplate(blockHeight: number) {

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


        await this.rpcBlockService.saveBlock(blockHeight, JSON.stringify(blockTemplate));

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
