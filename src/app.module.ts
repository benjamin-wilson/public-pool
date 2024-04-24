import { HttpModule } from '@nestjs/axios';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppController } from './app.controller';
import { AddressController } from './controllers/address/address.controller';
import { ClientController } from './controllers/client/client.controller';
import { BitcoinAddressValidator } from './models/validators/bitcoin-address.validator';
import { AddressSettingsModule } from './ORM/address-settings/address-settings.module';
import { BlocksModule } from './ORM/blocks/blocks.module';
import { ClientStatisticsModule } from './ORM/client-statistics/client-statistics.module';
import { ClientModule } from './ORM/client/client.module';
import { RpcBlocksModule } from './ORM/rpc-block/rpc-block.module';
import { TelegramSubscriptionsModule } from './ORM/telegram-subscriptions/telegram-subscriptions.module';
import { AppService } from './services/app.service';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';
import { BraiinsService } from './services/braiins.service';
import { BTCPayService } from './services/btc-pay.service';
import { DiscordService } from './services/discord.service';
import { NotificationService } from './services/notification.service';
import { ProxyService } from './services/proxy.service';
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
];

@Module({
  imports: [
    ConfigModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'sqlite',
      database: './DB/public-pool.sqlite',
      synchronize: true,
      autoLoadEntities: true,
      logging: false,
      enableWAL: true,
      busyTimeout: 30 * 1000,
    }),
    CacheModule.register(),
    ScheduleModule.forRoot(),
    HttpModule,
    ...ORMModules,
  ],
  controllers: [AppController, ClientController, AddressController],
  providers: [
    DiscordService,
    AppService,
    StratumV1Service,
    TelegramService,
    BitcoinRpcService,
    NotificationService,
    BitcoinAddressValidator,
    StratumV1JobsService,
    ProxyService,
    BTCPayService,
    BraiinsService,
  ],
})
export class AppModule {
  constructor() {}
}
