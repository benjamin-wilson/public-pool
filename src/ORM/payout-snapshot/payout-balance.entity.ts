import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

const bigintTransformer = {
    from: (value: string | number | null): number => Number(value ?? 0),
    to: (value: number): number => Math.trunc(value ?? 0),
};

@Entity({ name: 'payout_balance' })
export class PayoutBalanceEntity {
    @PrimaryColumn({ length: 62, type: 'varchar' })
    address: string;

    @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
    balanceSats: number;

    @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
    totalPaidSats: number;

    @Column({ type: 'timestamptz', nullable: true })
    lastAcceptedShareAt: Date | null;

    @UpdateDateColumn()
    updatedAt: Date;
}
