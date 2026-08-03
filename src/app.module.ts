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
import { UserAgentReportModule } from './ORM/_views/user-agent-report/user-agent-report.module';
import { AddressSettingsModule } from './ORM/address-settings/address-settings.module';
import { BlocksModule } from './ORM/blocks/blocks.module';
import { ClientStatisticsModule } from './ORM/client-statistics/client-statistics.module';
import { ClientModule } from './ORM/client/client.module';
import { PayoutSnapshotModule } from './ORM/payout-snapshot/payout-snapshot.module';
import { RpcBlocksModule } from './ORM/rpc-block/rpc-block.module';
import { ShareAccountingModule } from './ORM/share-accounting/share-accounting.module';
import { TelegramSubscriptionsModule } from './ORM/telegram-subscriptions/telegram-subscriptions.module';
import { createDatabaseOptions } from './database.config';
import { AppService } from './services/app.service';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';
import { BraiinsService } from './services/braiins.service';
import { BTCPayService } from './services/btc-pay.service';
import { DiscordService } from './services/discord.service';
import { CustomWorkService } from './services/custom-work.service';
import { DatumService } from './services/datum.service';
import { NotificationService } from './services/notification.service';
import { RedisMessagingModule } from './services/redis-messaging.module';
import { StratumV1JobsService } from './services/stratum-v1-jobs.service';
import { StratumV1Service } from './services/stratum-v1.service';
import { Sv2JobDeclarationRegistryService } from './services/sv2-job-declaration-registry.service';
import { Sv2JobDeclarationService } from './services/sv2-job-declaration.service';
import { Sv2TemplateDistributionService } from './services/sv2-template-distribution.service';
import { Sv2AuthorityService } from './services/sv2-authority.service';
import { StratumV2Service } from './services/stratum-v2.service';
import { TelegramService } from './services/telegram.service';
import { TemplateProviderService } from './services/template-provider.service';


const ORMModules = [
    ClientStatisticsModule,
    ClientModule,
    AddressSettingsModule,
    TelegramSubscriptionsModule,
    BlocksModule,
    RpcBlocksModule,
    UserAgentReportModule,
    ShareAccountingModule,
    PayoutSnapshotModule
]

@Module({
    imports: [
        ConfigModule.forRoot(),
        TypeOrmModule.forRootAsync({
            useFactory: (configService: ConfigService) => {
                return createDatabaseOptions({
                    ...process.env,
                    DB_HOST: configService.get('DB_HOST'),
                    DB_PORT: configService.get('DB_PORT'),
                    DB_USERNAME: configService.get('DB_USERNAME'),
                    DB_PASSWORD: configService.get('DB_PASSWORD'),
                    DB_DATABASE: configService.get('DB_DATABASE'),
                    DB_LOGGING: configService.get('DB_LOGGING'),
                    DB_POOL_SIZE: configService.get('DB_POOL_SIZE'),
                });
            },
            imports: [ConfigModule],
            inject: [ConfigService]
        }),
        CacheModule.register(),
        ScheduleModule.forRoot(),
        HttpModule,
        RedisMessagingModule,
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
        StratumV2Service,
        TemplateProviderService,
        Sv2JobDeclarationRegistryService,
        Sv2JobDeclarationService,
        Sv2TemplateDistributionService,
        Sv2AuthorityService,
        CustomWorkService,
        DatumService,
        BTCPayService,
        BraiinsService
    ],
})
export class AppModule {
    constructor() {

    }
}
