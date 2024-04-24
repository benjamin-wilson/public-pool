import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TelegramSubscriptionsEntity } from './telegram-subscriptions.entity';
import { TelegramSubscriptionsService } from './telegram-subscriptions.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([TelegramSubscriptionsEntity])],
  providers: [TelegramSubscriptionsService],
  exports: [TypeOrmModule, TelegramSubscriptionsService],
})
export class TelegramSubscriptionsModule {}
