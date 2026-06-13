import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PayoutBalanceEntity } from './payout-balance.entity';
import { PayoutHistoryEntity } from './payout-history.entity';
import { PayoutSnapshotEntryEntity } from './payout-snapshot-entry.entity';
import { PayoutSnapshotEntity } from './payout-snapshot.entity';
import { PayoutSnapshotService } from './payout-snapshot.service';

@Global()
@Module({
    imports: [TypeOrmModule.forFeature([
        PayoutBalanceEntity,
        PayoutHistoryEntity,
        PayoutSnapshotEntity,
        PayoutSnapshotEntryEntity,
    ])],
    providers: [PayoutSnapshotService],
    exports: [TypeOrmModule, PayoutSnapshotService],
})
export class PayoutSnapshotModule { }
