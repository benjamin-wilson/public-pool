import { Column, Entity, Index, OneToMany, PrimaryGeneratedColumn } from 'typeorm';

import { PayoutMode } from '../../types/payout-mode';
import { PayoutSnapshotEntryEntity } from './payout-snapshot-entry.entity';

@Entity({ name: 'payout_snapshot' })
@Index('IDX_payout_snapshot_latest', ['payoutMode', 'status', 'createdAt'])
@Index('IDX_payout_snapshot_window', ['windowEndShareIndex'])
export class PayoutSnapshotEntity {
    @PrimaryGeneratedColumn({ type: 'bigint' })
    id: string;

    @Column({ length: 32, type: 'varchar' })
    method: string;

    @Column({ length: 16, type: 'varchar', default: 'pplns' })
    payoutMode: PayoutMode;

    @Column({ length: 16, type: 'varchar', default: 'finalized' })
    status: 'finalized' | 'bridge_seed';

    @Column({ type: 'bigint' })
    blockHeight: number;

    @Column({ type: 'bigint' })
    coinbaseValueSats: string;

    @Column({ type: 'decimal' })
    networkDifficulty: number;

    @Column({ type: 'decimal', default: 0 })
    windowTargetDifficulty: number;

    @Column({ type: 'decimal', default: 4 })
    windowFactor: number;

    @Column({ length: 62, type: 'varchar', nullable: true })
    feeAddress?: string | null;

    @Column({ type: 'bigint', default: 0 })
    feeSats: string;

    @Column({ type: 'integer', default: 546 })
    minPayoutSats: number;

    @Column({ type: 'integer', default: 50000 })
    coinbaseWeightBudget: number;

    @Column({ type: 'bigint' })
    startBatchId: string;

    @Column({ type: 'bigint' })
    endBatchId: string;

    @Column({ type: 'bigint' })
    windowStartShareIndex: string;

    @Column({ type: 'bigint' })
    windowEndShareIndex: string;

    @Column({ type: 'decimal' })
    totalCreditedDifficulty: number;

    @Column({ type: 'bigint' })
    totalAcceptedShareCount: string;

    @Column({ type: 'integer' })
    eligibleAddressCount: number;

    @Column({ type: 'integer' })
    includedOutputCount: number;

    @Column({ type: 'bigint' })
    distributedSats: string;

    @Column({ type: 'bigint' })
    unallocatedRemainderSats: string;

    @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    createdAt: Date;

    @OneToMany(() => PayoutSnapshotEntryEntity, entry => entry.snapshot)
    entries: PayoutSnapshotEntryEntity[];
}
