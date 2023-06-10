import { Module } from '@nestjs/common';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BitcoinStratumProvider } from './bitcoin-stratum.provider';

@Module({
    imports: [],
    controllers: [AppController],
    providers: [AppService, BitcoinStratumProvider],
})
export class AppModule {
    constructor(private readonly bitcoinStratumProvider: BitcoinStratumProvider) {
        this.bitcoinStratumProvider.listen(3333);
    }
}
