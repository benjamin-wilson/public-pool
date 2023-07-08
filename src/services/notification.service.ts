import { Injectable, OnModuleInit } from '@nestjs/common';

import { DiscordService } from './discord.service';
import { TelegramService } from './telegram.service';


@Injectable()
export class NotificationService implements OnModuleInit {

    constructor(
        private readonly telegramService: TelegramService,
        private readonly discordService: DiscordService
    ) { }

    async onModuleInit(): Promise<void> {

    }

    public async notifySubscribersBlockFound(address: string) {
        await this.discordService.notifySUbscribersBlockFound();
        await this.telegramService.notifySubscribersBlockFound(address);
    }
}