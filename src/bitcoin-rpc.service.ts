import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RPCClient } from 'rpc-bitcoin';

import { IBlockTemplate } from './models/bitcoin-rpc/IBlockTemplate';
import { BehaviorSubject, Observable } from 'rxjs';
import { IMiningInfo } from './models/bitcoin-rpc/IMiningInfo';


@Injectable()
export class BitcoinRpcService {

    private blockHeight = 0;
    private client: RPCClient;
    private newBlock$: BehaviorSubject<number> = new BehaviorSubject(0);

    constructor(configService: ConfigService) {
        const url = configService.get('BITCOIN_RPC_URL');
        const user = configService.get('BITCOIN_RPC_USER');
        const pass = configService.get('BITCOIN_RPC_PASSWORD');
        const port = parseInt(configService.get('BITCOIN_RPC_PORT'));
        const timeout = parseInt(configService.get('BITCOIN_RPC_TIMEOUT'));

        this.client = new RPCClient({ url, port, timeout, user, pass });


        console.log('Bitcoin RPC connected');

        // Maybe use ZeroMQ ?
        setInterval(async () => {
            const miningInfo = await this.getMiningInfo();
            if (miningInfo.blocks > this.blockHeight) {
                console.log(miningInfo);
                if (this.blockHeight != 0) {
                    this.newBlock$.next(miningInfo.blocks + 1);
                }
                this.blockHeight = miningInfo.blocks;

            }

        }, 500);

    }


    public newBlock(): Observable<any> {
        return this.newBlock$.asObservable();
    }


    public async getBlockTemplate(): Promise<IBlockTemplate> {

        const result: IBlockTemplate = await this.client.getblocktemplate({
            template_request: {
                rules: ['segwit'],
                mode: 'template',
                capabilities: ['serverlist', 'proposal']
            }
        });

        return result;
    }

    public async getMiningInfo(): Promise<IMiningInfo> {
        return await this.client.getmininginfo();

    }

    public async SUBMIT_BLOCK(hexdata: string) {
        await this.client.submitblock({
            hexdata
        });
    }
}

