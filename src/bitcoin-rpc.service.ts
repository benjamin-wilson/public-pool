import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RPCClient } from 'rpc-bitcoin';

import { IBlockTempalte } from './models/IBlockTempalte';


@Injectable()
export class BitcoinRpcService implements OnModuleInit {

    private client: RPCClient;

    constructor(configService: ConfigService) {
        const url = configService.get('BITCOIN_RPC_URL');
        const user = configService.get('BITCOIN_RPC_USER');
        const pass = configService.get('BITCOIN_RPC_PASSWORD');
        const port = parseInt(configService.get('BITCOIN_RPC_PORT'));
        const timeout = parseInt(configService.get('BITCOIN_RPC_TIMEOUT'));

        this.client = new RPCClient({ url, port, timeout, user, pass });
        console.log('Bitcoin RPC connected');
    }

    async onModuleInit(): Promise<void> {
        console.log('onModuleInit');
        // Asynchronous initialization logic
        //await this.getBlockTemplate();

        return;
    }


    public async getBlockTemplate() {

        const result: IBlockTempalte = await this.client.getblocktemplate({
            template_request: {
                rules: ['segwit'],
                mode: 'template',
                capabilities: ['serverlist', 'proposal']
            }
        });

        console.log('Block Template: ', JSON.stringify(result));
    }
}

