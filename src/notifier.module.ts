import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { createDatabaseOptions } from './database.config';
import { PayoutSnapshotModule } from './ORM/payout-snapshot/payout-snapshot.module';
import { RpcBlocksModule } from './ORM/rpc-block/rpc-block.module';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';
import { RedisMessagingModule } from './services/redis-messaging.module';

/**
 * Minimal process graph for new-tip notification. Keeping API, Stratum,
 * reporting, chat integrations, and accounting providers out of this Nest
 * context prevents their timers and callbacks from delaying the Core longpoll.
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
        RpcBlocksModule,
        PayoutSnapshotModule,
    ],
    providers: [
        BitcoinRpcService,
    ],
})
export class NotifierModule { }
