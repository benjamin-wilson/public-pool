import { Column, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
@Index('IDX_accepted_share_accounting_lookup', ['address', 'clientName', 'acceptedAt'])
@Index('IDX_accepted_share_client_lookup', ['clientId', 'acceptedAt'])
@Index('IDX_accepted_share_unique_submission', ['acceptedAt', 'protocol', 'sessionId', 'jobId', 'nonce', 'ntime', 'version', 'extraNonce2'], { unique: true })
export class AcceptedShareEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @PrimaryColumn({ type: 'timestamptz' })
    acceptedAt: Date;

    @Column({ length: 8, type: 'varchar' })
    protocol: 'sv1' | 'sv2';

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
