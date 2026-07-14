import { ConfigModule, ConfigService } from '@nestjs/config';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UserAgentReportModule } from './ORM/_views/user-agent-report/user-agent-report.module';
import { ClientModule } from './ORM/client/client.module';
import { RpcBlocksModule } from './ORM/rpc-block/rpc-block.module';
import { ShareAccountingModule } from './ORM/share-accounting/share-accounting.module';
import { TelegramSubscriptionsModule } from './ORM/telegram-subscriptions/telegram-subscriptions.module';
import { createDatabaseOptions } from './database.config';
import { AppService } from './services/app.service';
import { DiscordService } from './services/discord.service';
import { NotificationService } from './services/notification.service';
import { RedisMessagingModule } from './services/redis-messaging.module';
import { TelegramService } from './services/telegram.service';

/**
 * Background process for non-hot-path master duties. Keep this separate from
 * NotifierModule so chat integrations, reporting, and cleanup timers cannot
 * delay block-template notification.
 */
@Module({
    imports: [
        ConfigModule.forRoot(),
        TypeOrmModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (configService: ConfigService) => createDatabaseOptions({
                ...process.env,
                DB_HOST: configService.get('DB_HOST'),
                DB_PORT: configService.get('DB_PORT'),
                DB_USERNAME: configService.get('DB_USERNAME'),
                DB_PASSWORD: configService.get('DB_PASSWORD'),
                DB_DATABASE: configService.get('DB_DATABASE'),
                DB_LOGGING: configService.get('DB_LOGGING'),
                DB_POOL_SIZE: configService.get('DB_POOL_SIZE'),
            }),
        }),
        RedisMessagingModule,
        ClientModule,
        RpcBlocksModule,
        UserAgentReportModule,
        ShareAccountingModule,
        TelegramSubscriptionsModule,
    ],
    providers: [
        AppService,
        DiscordService,
        NotificationService,
        TelegramService,
    ],
})
export class MaintenanceModule { }
