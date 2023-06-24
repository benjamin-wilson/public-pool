import { Column, Entity, OneToMany, PrimaryColumn } from 'typeorm';

import { ClientStatisticsEntity } from '../client-statistics/client-statistics.entity';
import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
export class ClientEntity extends TrackedEntity {
    @PrimaryColumn({ length: 8, type: 'varchar' })
    id: string;

    @Column({ type: 'datetime' })
    startTime: Date;

    @Column()
    clientName: string;

    @Column({ length: 62, type: 'varchar' })
    address: string;

    @Column({ default: 0 })
    bestDifficulty: number

    @OneToMany(
        () => ClientStatisticsEntity,
        clientStatistic => clientStatistic.client
    )
    clientStatistics?: ClientStatisticsEntity[];

}