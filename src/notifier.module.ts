import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { createDatabaseOptions } from './database.config';
import { AcceptedShareEntity } from './ORM/accepted-share/accepted-share.entity';
import { PayoutSnapshotModule } from './ORM/payout-snapshot/payout-snapshot.module';
import { RpcBlocksModule } from './ORM/rpc-block/rpc-block.module';
import { ShareAccountingService } from './ORM/share-accounting/share-accounting.service';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';
import { PoolSummaryRefreshService } from './services/pool-summary-refresh.service';
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
        TypeOrmModule.forFeature([AcceptedShareEntity]),
        RedisMessagingModule,
        RpcBlocksModule,
        PayoutSnapshotModule,
    ],
    providers: [
        BitcoinRpcService,
        PoolSummaryRefreshService,
        ShareAccountingService,
    ],
})
export class NotifierModule { }
