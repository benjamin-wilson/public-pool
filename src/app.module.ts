import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppController } from './app.controller';
import { AddressController } from './controllers/address/address.controller';
import { ClientController } from './controllers/client/client.controller';
import { AddressSettingsModule } from './ORM/address-settings/address-settings.module';
import { ClientStatisticsModule } from './ORM/client-statistics/client-statistics.module';
import { ClientModule } from './ORM/client/client.module';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';
import { BlockTemplateService } from './services/block-template.service';
import { CleanupService } from './services/cleanup.service';
import { StratumV1Service } from './services/stratum-v1.service';

const ORMModules = [
    ClientStatisticsModule,
    ClientModule,
    AddressSettingsModule
]

@Module({
    imports: [
        ConfigModule.forRoot(),
        TypeOrmModule.forRoot({
            type: 'sqlite',
            database: './DB/public-pool.sqlite',
            synchronize: true,
            autoLoadEntities: true,
            logging: false
        }),
        ScheduleModule.forRoot(),
        ...ORMModules
    ],
    controllers: [
        AppController,
        ClientController,
        AddressController
    ],
    providers: [

        CleanupService,
        StratumV1Service,
        BitcoinRpcService,
        BlockTemplateService
    ],
})
export class AppModule {
    constructor() {

    }
}
