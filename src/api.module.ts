import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppController } from './app.controller';
import { AddressController } from './controllers/address/address.controller';
import { ClientController } from './controllers/client/client.controller';
import { UserAgentReportModule } from './ORM/_views/user-agent-report/user-agent-report.module';
import { AddressSettingsModule } from './ORM/address-settings/address-settings.module';
import { BlocksModule } from './ORM/blocks/blocks.module';
import { ClientStatisticsModule } from './ORM/client-statistics/client-statistics.module';
import { ClientModule } from './ORM/client/client.module';
import { PayoutSnapshotModule } from './ORM/payout-snapshot/payout-snapshot.module';
import { RpcBlocksModule } from './ORM/rpc-block/rpc-block.module';
import { ShareAccountingModule } from './ORM/share-accounting/share-accounting.module';
import { createDatabaseOptions } from './database.config';
import { BitcoinAddressValidator } from './models/validators/bitcoin-address.validator';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';
import { RedisMessagingModule } from './services/redis-messaging.module';
import { Sv2AuthorityService } from './services/sv2-authority.service';

@Module({
    imports: [
        ConfigModule.forRoot(),
        TypeOrmModule.forRootAsync({
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
            imports: [ConfigModule],
            inject: [ConfigService],
        }),
        CacheModule.register(),
        RedisMessagingModule,
        ClientStatisticsModule,
        ClientModule,
        AddressSettingsModule,
        BlocksModule,
        RpcBlocksModule,
        UserAgentReportModule,
        ShareAccountingModule,
        PayoutSnapshotModule,
    ],
    controllers: [
        AppController,
        ClientController,
        AddressController,
    ],
    providers: [
        BitcoinRpcService,
        BitcoinAddressValidator,
        Sv2AuthorityService,
    ],
})
export class ApiModule {}
