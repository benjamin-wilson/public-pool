import { HttpModule } from '@nestjs/axios';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppController } from './app.controller';
import { AddressController } from './controllers/address/address.controller';
import { ClientController } from './controllers/client/client.controller';
import { BitcoinAddressValidator } from './models/validators/bitcoin-address.validator';
import { UniqueNonceIndex } from './ORM/_migrations/UniqueNonceIndex';
import { UserAgentReportModule } from './ORM/_views/user-agent-report/user-agent-report.module';
import { UserAgentReportView } from './ORM/_views/user-agent-report/user-agent-report.view';
import { AddressSettingsEntity } from './ORM/address-settings/address-settings.entity';
import { AddressSettingsModule } from './ORM/address-settings/address-settings.module';
import { BlocksEntity } from './ORM/blocks/blocks.entity';
import { BlocksModule } from './ORM/blocks/blocks.module';
import { ClientStatisticsEntity } from './ORM/client-statistics/client-statistics.entity';
import { ClientStatisticsModule } from './ORM/client-statistics/client-statistics.module';
import { ClientEntity } from './ORM/client/client.entity';
import { ClientModule } from './ORM/client/client.module';
import { HomeGraphEntity } from './ORM/home-graph/home-graph.entity';
import { HomeGraphModule } from './ORM/home-graph/home-graph.module';
import { RpcBlockEntity } from './ORM/rpc-block/rpc-block.entity';
import { RpcBlocksModule } from './ORM/rpc-block/rpc-block.module';
import { TelegramSubscriptionsEntity } from './ORM/telegram-subscriptions/telegram-subscriptions.entity';
import { TelegramSubscriptionsModule } from './ORM/telegram-subscriptions/telegram-subscriptions.module';
import { AppService } from './services/app.service';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';
import { BraiinsService } from './services/braiins.service';
import { BTCPayService } from './services/btc-pay.service';
import { DiscordService } from './services/discord.service';
import { NotificationService } from './services/notification.service';
import { StratumV1JobsService } from './services/stratum-v1-jobs.service';
import { StratumV1Service } from './services/stratum-v1.service';
import { TelegramService } from './services/telegram.service';


const ORMModules = [
    ClientStatisticsModule,
    ClientModule,
    AddressSettingsModule,
    TelegramSubscriptionsModule,
    BlocksModule,
    RpcBlocksModule,
    HomeGraphModule,
    UserAgentReportModule
]

@Module({
    imports: [
        ConfigModule.forRoot(),
        TypeOrmModule.forRootAsync({
            useFactory: (configService: ConfigService) => {
                return {
                    type: 'postgres',
                    host: configService.get('DB_HOST'),
                    port: parseInt(configService.get('DB_PORT')),
                    username: configService.get('DB_USERNAME'),
                    password: configService.get('DB_PASSWORD'),
                    database: configService.get('DB_DATABASE'),
                    entities: [
                        ClientEntity,
                        AddressSettingsEntity,
                        BlocksEntity,
                        ClientStatisticsEntity,
                        RpcBlockEntity,
                        TelegramSubscriptionsEntity,
                        HomeGraphEntity,
                        UserAgentReportView
                    ],
                    synchronize: configService.get('PRODUCTION') != 'true',
                    logging: false,
                    poolSize: 30,
                    migrations: [
                        UniqueNonceIndex
                    ]
                }
            },
            imports: [ConfigModule],
            inject: [ConfigService]
        }),
        CacheModule.register(),
        ScheduleModule.forRoot(),
        HttpModule,
        ...ORMModules
    ],
    controllers: [
        AppController,
        ClientController,
        AddressController
    ],
    providers: [
        DiscordService,
        AppService,
        StratumV1Service,
        TelegramService,
        BitcoinRpcService,
        NotificationService,
        BitcoinAddressValidator,
        StratumV1JobsService,
        BTCPayService,
        BraiinsService
    ],
})
export class AppModule {
    constructor() {

    }
}
