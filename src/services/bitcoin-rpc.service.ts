import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RPCClient } from 'rpc-bitcoin';
import { BehaviorSubject, filter, shareReplay } from 'rxjs';

import { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { IMiningInfo } from '../models/bitcoin-rpc/IMiningInfo';

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

        // Maybe use ZeroMQ ?
        setInterval(async () => {
            const miningInfo = await this.getMiningInfo();
            if (miningInfo != null && miningInfo.blocks > this.blockHeight) {
                this._newBlock$.next(miningInfo);
                this.blockHeight = miningInfo.blocks;
            }

        }, 500);
    }


    public async getBlockTemplate(): Promise<IBlockTemplate> {

        const result: IBlockTemplate = await this.client.getblocktemplate({
            template_request: {
                rules: ['segwit'],
                mode: 'template',
                capabilities: ['serverlist', 'proposal']
            }
        });
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

