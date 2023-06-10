import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { BitcoinStratumProvider } from './bitcoin-stratum.provider';



@Module({
    imports: [
        ConfigModule
    ],
    controllers: [AppController],
    providers: [
        AppService,
        BitcoinStratumProvider,
        BitcoinRpcService
    ],
})
export class AppModule {
    constructor(private readonly bitcoinStratumProvider: BitcoinStratumProvider) {
        this.bitcoinStratumProvider.listen(3333);
    }
}
