import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { validate } from 'bitcoin-address-validation';
import { Block } from 'bitcoinjs-lib';

import { TelegramSubscriptionsService } from '../ORM/telegram-subscriptions/telegram-subscriptions.service';


@Injectable()
export class TelegramService implements OnModuleInit {

    private bot: AxiosInstance;
    private updateOffset = 0;
    private pollingTimer: NodeJS.Timeout;

    constructor(
        private readonly configService: ConfigService,
        private readonly telegramSubscriptionsService: TelegramSubscriptionsService
    ) {
        const token: string | null = this.configService.get('TELEGRAM_BOT_TOKEN');
        if (token == null || token.length < 1) {
            return;
        }
        this.bot = axios.create({
            baseURL: `https://api.telegram.org/bot${token}/`,
            timeout: 10000
        });
        console.log('Telegram bot init');


    }

    async onModuleInit(): Promise<void> {

        if (this.bot == null) {
            return;
        }

        await this.pollUpdates();
        this.pollingTimer = setInterval(async () => {
            await this.pollUpdates();
        }, 2000);
    }

    public async notifySubscribersBlockFound(address: string, height: number, block: Block, message: string) {
        if (this.bot == null) {
            return;
        }

        const subscribers = await this.telegramSubscriptionsService.getSubscriptions(address);
        await Promise.all(subscribers.map(subscriber => {
            return this.sendMessage(subscriber.telegramChatId, `Block Found! Result: ${message}, Height: ${height}`);
        }));
    }

    private async pollUpdates() {
        try {
            const response = await this.bot.get('getUpdates', {
                params: {
                    offset: this.updateOffset,
                    timeout: 0
                }
            });

            for (const update of response.data.result ?? []) {
                this.updateOffset = update.update_id + 1;
                await this.handleMessage(update.message);
            }
        } catch (e) {
            console.error('Telegram polling failed', e.message);
        }
    }

    private async handleMessage(msg: any) {
        if (msg?.text == null) {
            return;
        }

        if (msg.text.startsWith('/subscribe')) {
            const address = msg.text.split('/subscribe ')[1];
            if (validate(address) == false) {
                await this.sendMessage(msg.chat.id, 'Invalid address.');
                return;
            }
            await this.telegramSubscriptionsService.saveSubscription(msg.chat.id, address);
            await this.sendMessage(msg.chat.id, 'Subscribed!');
            return;
        }

        if (msg.text.startsWith('/start')) {
            await this.sendMessage(msg.chat.id, 'Welcome to the public-pool bot. /subscribe <address> to get notified.');
            return;
        }

        console.log(msg);
    }

    private async sendMessage(chatId: number | string, text: string) {
        await this.bot.post('sendMessage', {
            chat_id: chatId,
            text
        });
    }
}
