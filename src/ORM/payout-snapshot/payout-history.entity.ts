import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { PayoutMode } from '../../types/payout-mode';

const bigintTransformer = {
    from: (value: string | number | null): number => Number(value ?? 0),
    to: (value: number): number => Math.trunc(value ?? 0),
};

@Entity({ name: 'payout_history' })
@Index('UQ_payout_history_block_address', ['payoutMode', 'blockHeight', 'address'], { unique: true })
@Index('IDX_payout_history_address_created', ['address', 'createdAt'])
export class PayoutHistoryEntity {
    @PrimaryGeneratedColumn({ type: 'bigint' })
    id: string;

    @Column({ type: 'bigint' })
    blockHeight: number;

    @Column({ type: 'bigint' })
    payoutSnapshotId: string;

    @Column({ length: 16, type: 'varchar', default: 'pplns' })
    payoutMode: PayoutMode;

    @Column({ length: 62, type: 'varchar' })
    address: string;

    @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
    paidSats: number;

    @Column({ type: 'decimal', default: 0 })
    percent: number;

    @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
    balanceBeforeSats: number;

    @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
    balanceAfterSats: number;

    @Column({ length: 16, type: 'varchar', default: 'coinbase' })
    rowType: 'coinbase' | 'pending';

    @CreateDateColumn()
    createdAt: Date;
}
