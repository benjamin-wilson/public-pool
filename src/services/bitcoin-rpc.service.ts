import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RPCClient } from 'rpc-bitcoin';
import { BehaviorSubject, filter, shareReplay } from 'rxjs';

import { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { IMiningInfo } from '../models/bitcoin-rpc/IMiningInfo';
import * as zmq from 'zeromq';

@Injectable()
export class BitcoinRpcService {

    private blockHeight = 0;
    private client: RPCClient;
    private _newBlock$: BehaviorSubject<IMiningInfo> = new BehaviorSubject(undefined);
    public newBlock$ = this._newBlock$.pipe(filter(block => block != null), shareReplay({ refCount: true, bufferSize: 1 }));

    constructor(private readonly configService: ConfigService) {
        const url = this.configService.get('BITCOIN_RPC_URL');
        const user = this.configService.get('BITCOIN_RPC_USER');
        const pass = this.configService.get('BITCOIN_RPC_PASSWORD');
        const port = parseInt(this.configService.get('BITCOIN_RPC_PORT'));
        const timeout = parseInt(this.configService.get('BITCOIN_RPC_TIMEOUT'));

        this.client = new RPCClient({ url, port, timeout, user, pass });

        console.log('Bitcoin RPC connected');

        if (this.configService.get('BITCOIN_ZMQ_HOST')) {
            const sock = zmq.socket("sub");
            sock.connect(this.configService.get('BITCOIN_ZMQ_HOST'));
            sock.subscribe("rawblock");
            sock.on("message", async (topic: Buffer, message: Buffer) => {
                console.log("new block zmq");
                this.pollMiningInfo();
            });
            this.pollMiningInfo();
        } else {
            setInterval(this.pollMiningInfo.bind(this), 500);
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

    public async getBlockTemplate(): Promise<IBlockTemplate> {
        let result: IBlockTemplate;
        try {
            result = await this.client.getblocktemplate({
                template_request: {
                    rules: ['segwit'],
                    mode: 'template',
                    capabilities: ['serverlist', 'proposal']
                }
            });
        } catch (e) {
            console.log('Error getblocktemplate');
            throw new Error('Error getblocktemplate');
        }
        console.log(`getblocktemplate tx count: ${result.transactions.length}`);
        return result;
    }

    public async getMiningInfo(): Promise<IMiningInfo> {
        try {
            return await this.client.getmininginfo();
        } catch (e) {
            console.log('Error getmininginfo');
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

