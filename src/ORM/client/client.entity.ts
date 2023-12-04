import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';


@Entity()
@Index(['address', 'clientName', 'sessionId'], { unique: true })
export class ClientEntity extends TrackedEntity {


    @PrimaryColumn({ length: 62, type: 'varchar' })
    address: string;

    @PrimaryColumn({ length: 64, type: 'varchar' })
    clientName: string;

    @PrimaryColumn({ length: 8, type: 'varchar' })
    sessionId: string;


    @Column({ length: 128, type: 'varchar', nullable: true })
    userAgent: string;



    @Column({ type: 'timestamp' })
    startTime: Date;

    @Column({ type: 'decimal', default: 0 })
    bestDifficulty: number

    @Column({ default: 0, type: 'decimal' })
    hashRate: number;

}

