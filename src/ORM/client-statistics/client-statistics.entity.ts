import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { DateTimeTransformer } from '../utils/DateTimeTransformer';
import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
export class ClientStatisticsEntity extends TrackedEntity {

    @PrimaryGeneratedColumn()
    id: number;

    @Column({ length: 62, type: 'varchar' })
    address: string;

    @Column()
    clientName: string;

    @Index()
    @Column({ length: 8, type: 'varchar' })
    sessionId: string;

    @Index()
    @Column({
        type: 'datetime',
        transformer: new DateTimeTransformer()
    })
    time: Date;

    @Column()
    difficulty: number;




}