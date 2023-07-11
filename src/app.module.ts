import { CacheModule } from '@nestjs/cache-manager';
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
import { TelegramSubscriptionsModule } from './ORM/telegram-subscriptions/telegram-subscriptions.module';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';
import { BlockTemplateService } from './services/block-template.service';
import { CleanupService } from './services/cleanup.service';
import { DiscordService } from './services/discord.service';
import { NotificationService } from './services/notification.service';
import { StratumV1Service } from './services/stratum-v1.service';
import { TelegramService } from './services/telegram.service';

const ORMModules = [
    ClientStatisticsModule,
    ClientModule,
    AddressSettingsModule,
    TelegramSubscriptionsModule
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
        CacheModule.register(),
        ScheduleModule.forRoot(),

        ...ORMModules
    ],
    controllers: [
        AppController,
        ClientController,
        AddressController
    ],
    providers: [
        DiscordService,
        CleanupService,
        StratumV1Service,
        TelegramService,
        BitcoinRpcService,
        BlockTemplateService,
        NotificationService
    ],
})
export class AppModule {
    constructor() {

    }
}
