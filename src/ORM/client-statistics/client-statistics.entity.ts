import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
//Index for the heartbeat update
@Index(["address", "clientName", "sessionId", "time"])
export class ClientStatisticsEntity extends TrackedEntity {

    @PrimaryColumn({ length: 64, type: 'varchar' })
    submissionHash: string;


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