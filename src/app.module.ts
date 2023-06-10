import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { BitcoinStratumProvider } from './bitcoin-stratum.provider';
import { CoinbaseConstructorService } from './coinbase-constructor.service';



@Module({
    imports: [
        ConfigModule.forRoot()
    ],
    controllers: [AppController],
    providers: [
        AppService,
        BitcoinStratumProvider,
        BitcoinRpcService,
        CoinbaseConstructorService
    ],
})
export class AppModule {
    constructor() {

    }
}
