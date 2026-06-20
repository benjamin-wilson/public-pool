import { Column, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

import { PayoutMode } from '../../types/payout-mode';

@Entity()
@Index('IDX_accepted_share_mode_order', ['payoutMode', 'shareIndex'])
@Index('IDX_accepted_share_unique_submission', ['acceptedAt', 'payoutMode', 'protocol', 'sessionId', 'jobId', 'nonce', 'ntime', 'version', 'extraNonce2'], { unique: true })
export class AcceptedShareEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @PrimaryColumn({ type: 'timestamptz' })
    acceptedAt: Date;

    @Column({ type: 'bigint', default: () => `nextval('accepted_share_index_seq')` })
    shareIndex: number;

    @Column({ length: 16, type: 'varchar' })
    protocol: 'sv1' | 'sv1_tls' | 'sv2' | 'sv2_jdp' | 'datum';

    @Column({ length: 16, type: 'varchar', default: 'solo' })
    payoutMode: PayoutMode;

    @Column({ length: 16, type: 'varchar', default: 'pool_template' })
    workSource: 'pool_template' | 'miner_template';

    @Column({ length: 16, type: 'varchar', default: 'pool' })
    workProtocol: 'pool' | 'sv2_jdp' | 'datum';

    @Column({ length: 62, type: 'varchar' })
    address: string;

    @Column()
    clientName: string;

    @Column({ length: 8, type: 'varchar' })
    sessionId: string;

    @Column({ type: 'uuid' })
    clientId: string;

    @Column()
    jobId: string;

    @Column()
    jobTemplateId: string;

    @Column({ type: 'bigint' })
    blockHeight: number;

    @Column({ type: 'decimal' })
    creditedDifficulty: number;

    @Column({ type: 'decimal' })
    submissionDifficulty: number;

    @Column({ type: 'decimal' })
    networkDifficulty: number;

    @Column()
    nonce: string;

    @Column()
    ntime: string;

    @Column()
    version: string;

    @Column()
    extraNonce2: string;

    @Column({ default: false })
    isBlockCandidate: boolean;

    @Column({ type: 'text', nullable: true })
    blockSubmissionResult?: string;

    @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    createdAt: Date;
}
