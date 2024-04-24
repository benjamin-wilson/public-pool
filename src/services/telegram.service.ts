import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validate } from 'bitcoin-address-validation';
import { Block } from 'bitcoinjs-lib';
import * as TelegramBot from 'node-telegram-bot-api';

import { TelegramSubscriptionsService } from '../ORM/telegram-subscriptions/telegram-subscriptions.service';

@Injectable()
export class TelegramService implements OnModuleInit {
  private bot: TelegramBot;

  constructor(
    private readonly configService: ConfigService,
    private readonly telegramSubscriptionsService: TelegramSubscriptionsService,
  ) {
    const token: string | null = this.configService.get('TELEGRAM_BOT_TOKEN');
    if (token == null || token.length < 1) {
      return;
    }
    this.bot = new TelegramBot(token, { polling: true });
    console.log('Telegram bot init');
  }

  async onModuleInit(): Promise<void> {
    if (this.bot == null) {
      return;
    }

    this.bot.onText(/\/subscribe/, async (msg) => {
      const address = msg.text.split('/subscribe ')[1];
      if (validate(address) == false) {
        this.bot.sendMessage(msg.chat.id, 'Invalid address.');
        return;
      }
      await this.telegramSubscriptionsService.saveSubscription(
        msg.chat.id,
        address,
      );
      this.bot.sendMessage(msg.chat.id, 'Subscribed!');
    });

    this.bot.onText(/\/start/, (msg) => {
      this.bot.sendMessage(
        msg.chat.id,
        'Welcome to the public-pool bot. /subscribe <address> to get notified.',
      );
    });

    this.bot.on('message', (msg) => {
      console.log(msg);
    });
  }

  public async notifySubscribersBlockFound(
    address: string,
    height: number,
    block: Block,
    message: string,
  ) {
    if (this.bot == null) {
      return;
    }

    const subscribers =
      await this.telegramSubscriptionsService.getSubscriptions(address);
    subscribers.forEach((subscriber) => {
      this.bot.sendMessage(
        subscriber.telegramChatId,
        `Block Found! Result: ${message}, Height: ${height}`,
      );
    });
  }
}
