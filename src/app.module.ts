import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { BlockTemplateService } from './BlockTemplateService';
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
        BlockTemplateService
    ],
})
export class AppModule {
    constructor() {

    }
}
