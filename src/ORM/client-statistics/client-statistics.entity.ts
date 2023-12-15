import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
//Index for getHashRateForSession
@Index(["address", "clientName", "sessionId"])
export class ClientStatisticsEntity extends TrackedEntity {

    @PrimaryGeneratedColumn()
    id: number;

    @Column({ length: 62, type: 'varchar' })
    address: string;

    @Column()
    clientName: string;

    @Column({ length: 8, type: 'varchar' })
    sessionId: string;

    @Index()
    @Column({ type: 'bigint' })
    time: number;

    @Column({ type: 'decimal' })
    shares: number;

    @Column({ default: 0, type: 'bigint' })
    acceptedCount: number;




}