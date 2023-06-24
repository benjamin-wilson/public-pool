import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { BlockTemplateService } from './BlockTemplateService';
import { ClientStatisticsModule } from './ORM/client-statistics/client-statistics.module';
import { ClientModule } from './ORM/client/client.module';
import { StratumV1Service } from './stratum-v1.service';

const ORMModules = [
    ClientStatisticsModule,
    ClientModule
]

@Module({
    imports: [
        ConfigModule.forRoot(),
        TypeOrmModule.forRoot({
            type: 'sqlite',
            database: './DB/public-pool.sqlite',
            synchronize: true,
            autoLoadEntities: true,
        }),
        ...ORMModules
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
