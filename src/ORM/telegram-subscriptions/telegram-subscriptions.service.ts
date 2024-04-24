import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TelegramSubscriptionsEntity } from './telegram-subscriptions.entity';

@Injectable()
export class TelegramSubscriptionsService {
  constructor(
    @InjectRepository(TelegramSubscriptionsEntity)
    private telegramSubscriptions: Repository<TelegramSubscriptionsEntity>,
  ) {}

  public async getSubscriptions(address: string) {
    return await this.telegramSubscriptions.find({ where: { address } });
  }

  public async saveSubscription(chatId: number, address: string) {
    return await this.telegramSubscriptions.save({
      telegramChatId: chatId,
      address,
    });
  }
}
