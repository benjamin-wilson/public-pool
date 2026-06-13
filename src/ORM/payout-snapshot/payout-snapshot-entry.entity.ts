import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { PayoutSnapshotEntity } from './payout-snapshot.entity';

@Entity({ name: 'payout_snapshot_entry' })
@Index('IDX_payout_snapshot_entry_snapshot_rank', ['snapshotId', 'rank'])
@Index('IDX_payout_snapshot_entry_address', ['address'])
export class PayoutSnapshotEntryEntity {
    @PrimaryGeneratedColumn({ type: 'bigint' })
    id: string;

    @Column({ type: 'bigint' })
    snapshotId: string;

    @ManyToOne(() => PayoutSnapshotEntity, snapshot => snapshot.entries, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'snapshotId' })
    snapshot: PayoutSnapshotEntity;

    @Column({ length: 62, type: 'varchar' })
    address: string;

    @Column({ type: 'decimal' })
    creditedDifficulty: number;

    @Column({ type: 'bigint' })
    acceptedShareCount: string;

    @Column({ type: 'decimal' })
    payoutWeight: number;

    @Column({ type: 'bigint' })
    grossPayoutSats: string;

    @Column({ type: 'bigint' })
    payoutSats: string;

    @Column({ type: 'bigint', default: 0 })
    balanceBeforeSats: string;

    @Column({ type: 'bigint', default: 0 })
    balanceAfterSats: string;

    @Column({ type: 'boolean', default: true })
    includedInCoinbase: boolean;

    @Column({ length: 16, type: 'varchar', default: 'coinbase' })
    rowType: 'coinbase' | 'pending';

    @Column({ type: 'integer' })
    rank: number;

    @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    createdAt: Date;
}
