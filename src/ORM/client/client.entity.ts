import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
export class ClientEntity extends TrackedEntity {

    @PrimaryGeneratedColumn()
    id: number;


    @Column({ length: 62, type: 'varchar' })
    address: string;

    @Column()
    clientName: string;

    @Column({ length: 8, type: 'varchar' })
    sessionId: string;

    @Column({ type: 'datetime' })
    startTime: Date;



    @Column({ default: 0 })
    bestDifficulty: number



}

