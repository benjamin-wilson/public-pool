import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DataSourceOptions } from 'typeorm';

import { InitialTimescaleSchema1780859300000 } from './ORM/_migrations/InitialTimescaleSchema1780859300000';
import { ActiveOnlyUserAgentReport1780860200000 } from './ORM/_migrations/ActiveOnlyUserAgentReport1780860200000';
import { TimescaleOperationalHardening1780861200000 } from './ORM/_migrations/TimescaleOperationalHardening1780861200000';
import { AcceptedShareIndex1780862400000 } from './ORM/_migrations/AcceptedShareIndex1780862400000';
import { AcceptedShareRollupIndexes1780865400000 } from './ORM/_migrations/AcceptedShareRollupIndexes1780865400000';
import { PoolAccountingDashboardIndexes1780867200000 } from './ORM/_migrations/PoolAccountingDashboardIndexes1780867200000';
import { CurrentRoundBestShareIndex1780897600000 } from './ORM/_migrations/CurrentRoundBestShareIndex1780897600000';
import { UserAgentReportView } from './ORM/_views/user-agent-report/user-agent-report.view';
import { AcceptedShareEntity } from './ORM/accepted-share/accepted-share.entity';
import { AddressSettingsEntity } from './ORM/address-settings/address-settings.entity';
import { BlocksEntity } from './ORM/blocks/blocks.entity';
import { ClientEntity } from './ORM/client/client.entity';
import { RpcBlockEntity } from './ORM/rpc-block/rpc-block.entity';
import { TelegramSubscriptionsEntity } from './ORM/telegram-subscriptions/telegram-subscriptions.entity';

export const databaseEntities = [
    ClientEntity,
    AddressSettingsEntity,
    BlocksEntity,
    RpcBlockEntity,
    TelegramSubscriptionsEntity,
    UserAgentReportView,
    AcceptedShareEntity,
];

export const databaseMigrations = [
    InitialTimescaleSchema1780859300000,
    ActiveOnlyUserAgentReport1780860200000,
    TimescaleOperationalHardening1780861200000,
    AcceptedShareIndex1780862400000,
    AcceptedShareRollupIndexes1780865400000,
    PoolAccountingDashboardIndexes1780867200000,
    CurrentRoundBestShareIndex1780897600000,
];

export function createDatabaseOptions(env: NodeJS.ProcessEnv): TypeOrmModuleOptions & DataSourceOptions {
    return {
        type: 'postgres',
        host: env.DB_HOST,
        port: parseInt(env.DB_PORT ?? '5432', 10),
        username: env.DB_USERNAME,
        password: env.DB_PASSWORD,
        database: env.DB_DATABASE,
        entities: databaseEntities,
        synchronize: false,
        logging: env.DB_LOGGING === 'true',
        poolSize: parseInt(env.DB_POOL_SIZE ?? '10', 10),
        ssl: env.DB_SSL === 'true'
            ? { rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
            : undefined,
        migrations: databaseMigrations,
        migrationsTransactionMode: 'none',
    };
}
