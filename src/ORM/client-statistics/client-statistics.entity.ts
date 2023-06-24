import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { ClientEntity } from '../client/client.entity';

@Entity()
export class ClientStatisticsEntity {

    @PrimaryGeneratedColumn()
    id: number;

    @Column({ type: 'datetime' })
    time: Date;

    @Column()
    difficulty: number;


    @ManyToOne(
        () => ClientEntity,
        client => client.clientStatistics
    )
    client: ClientEntity;

}