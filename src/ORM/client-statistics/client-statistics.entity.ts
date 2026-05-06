import { Column, Entity, Index, ManyToOne } from 'typeorm';

import { ClientEntity } from '../client/client.entity';
import { PrimaryGeneratedBigIntColumn } from '../utils/PrimaryGeneratedBigIntColumn';
import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
//Index for statistics save
@Index(["clientId", "time"])
export class ClientStatisticsEntity extends TrackedEntity {

    @PrimaryGeneratedBigIntColumn()
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



    @ManyToOne(
        () => ClientEntity,
        clientEntity => clientEntity.statistics,
        { nullable: false, }
    )
    client: ClientEntity;

    @Index()
    @Column({ name: 'clientId' })
    public clientId: string;


}
