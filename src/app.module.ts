import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { CoinbaseConstructorService } from './coinbase-constructor.service';
import { StratumV1JobsService } from './stratum-v1-jobs.service';
import { StratumV1Service } from './stratum-v1.service';



@Module({
    imports: [
        ConfigModule.forRoot()
    ],
    controllers: [AppController],
    providers: [
        AppService,
        StratumV1Service,
        BitcoinRpcService,
        CoinbaseConstructorService,
        StratumV1JobsService
    ],
})
export class AppModule {
    constructor() {

    }
}
