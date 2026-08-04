import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DataSourceOptions } from 'typeorm';

import { InitialTimescaleSchema1780859300000 } from './ORM/_migrations/InitialTimescaleSchema1780859300000';
import { ActiveOnlyUserAgentReport1780860200000 } from './ORM/_migrations/ActiveOnlyUserAgentReport1780860200000';
import { TimescaleOperationalHardening1780861200000 } from './ORM/_migrations/TimescaleOperationalHardening1780861200000';
import { AcceptedShareIndex1780862400000 } from './ORM/_migrations/AcceptedShareIndex1780862400000';
import { AcceptedShareRollupIndexes1780865400000 } from './ORM/_migrations/AcceptedShareRollupIndexes1780865400000';
import { PoolAccountingDashboardIndexes1780867200000 } from './ORM/_migrations/PoolAccountingDashboardIndexes1780867200000';
import { CurrentRoundBestShareIndex1780897600000 } from './ORM/_migrations/CurrentRoundBestShareIndex1780897600000';
import { CurrentRoundWorkRollup1780899000000 } from './ORM/_migrations/CurrentRoundWorkRollup1780899000000';
import { ShareRollupBatches1780962600000 } from './ORM/_migrations/ShareRollupBatches1780962600000';
import { AcceptedShareRetentionCompression1780966200000 } from './ORM/_migrations/AcceptedShareRetentionCompression1780966200000';
import { PayoutSnapshots1780969800000 } from './ORM/_migrations/PayoutSnapshots1780969800000';
import { AcceptedShareProtocolMetadata1781130600000 } from './ORM/_migrations/AcceptedShareProtocolMetadata1781130600000';
import { BlocksSubmissionMetadata1781220000000 } from './ORM/_migrations/BlocksSubmissionMetadata1781220000000';
import { PayoutModes1781300000000 } from './ORM/_migrations/PayoutModes1781300000000';
import { ShareRollupStoragePolicy1781305000000 } from './ORM/_migrations/ShareRollupStoragePolicy1781305000000';
import { AcceptedShareHighScores1781309000000 } from './ORM/_migrations/AcceptedShareHighScores1781309000000';
import { UserAgentReportNonzeroHashrate1781313000000 } from './ORM/_migrations/UserAgentReportNonzeroHashrate1781313000000';
import { PoolSummaryContinuousAggregate1781400000000 } from './ORM/_migrations/PoolSummaryContinuousAggregate1781400000000';
import { PoolSummaryRefreshWindow1781401000000 } from './ORM/_migrations/PoolSummaryRefreshWindow1781401000000';
import { AcceptedShareHighScoreNumericRetention1781402000000 } from './ORM/_migrations/AcceptedShareHighScoreNumericRetention1781402000000';
import { AcceptedShare10mLookupIndexes1781403000000 } from './ORM/_migrations/AcceptedShare10mLookupIndexes1781403000000';
import { UserAgentReportView } from './ORM/_views/user-agent-report/user-agent-report.view';
import { AcceptedShareEntity } from './ORM/accepted-share/accepted-share.entity';
import { AddressSettingsEntity } from './ORM/address-settings/address-settings.entity';
import { BlocksEntity } from './ORM/blocks/blocks.entity';
import { ClientEntity } from './ORM/client/client.entity';
import { PayoutBalanceEntity } from './ORM/payout-snapshot/payout-balance.entity';
import { PayoutHistoryEntity } from './ORM/payout-snapshot/payout-history.entity';
import { PayoutSnapshotEntity } from './ORM/payout-snapshot/payout-snapshot.entity';
import { PayoutSnapshotEntryEntity } from './ORM/payout-snapshot/payout-snapshot-entry.entity';
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
    PayoutBalanceEntity,
    PayoutHistoryEntity,
    PayoutSnapshotEntity,
    PayoutSnapshotEntryEntity,
];

export const databaseMigrations = [
    InitialTimescaleSchema1780859300000,
    ActiveOnlyUserAgentReport1780860200000,
    TimescaleOperationalHardening1780861200000,
    AcceptedShareIndex1780862400000,
    AcceptedShareRollupIndexes1780865400000,
    PoolAccountingDashboardIndexes1780867200000,
    CurrentRoundBestShareIndex1780897600000,
    CurrentRoundWorkRollup1780899000000,
    ShareRollupBatches1780962600000,
    AcceptedShareRetentionCompression1780966200000,
    PayoutSnapshots1780969800000,
    AcceptedShareProtocolMetadata1781130600000,
    BlocksSubmissionMetadata1781220000000,
    PayoutModes1781300000000,
    ShareRollupStoragePolicy1781305000000,
    AcceptedShareHighScores1781309000000,
    UserAgentReportNonzeroHashrate1781313000000,
    PoolSummaryContinuousAggregate1781400000000,
    PoolSummaryRefreshWindow1781401000000,
    AcceptedShareHighScoreNumericRetention1781402000000,
    AcceptedShare10mLookupIndexes1781403000000,
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
