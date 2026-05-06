import { Column, Entity, Index, OneToMany, PrimaryGeneratedColumn } from 'typeorm';

import { ClientStatisticsEntity } from '../client-statistics/client-statistics.entity';
import { TrackedEntity } from '../utils/TrackedEntity.entity';


@Entity()
@Index("IDX_unique_nonce", { synchronize: false })
@Index('idx_client_cleanup', ['id'], {
    where: '"deletedAt" IS NULL',
    // This is a partial (filtered) index — only indexes active clients
})
export class ClientEntity extends TrackedEntity {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ length: 62, type: 'varchar' })
    address: string;

    @Column({ length: 64, type: 'varchar' })
    clientName: string;

    @Column({ length: 8, type: 'varchar', })
    sessionId: string;


    @Column({ length: 128, type: 'varchar', nullable: true })
    userAgent: string;


    @Column()
    startTime: Date;

    @Column({ type: 'decimal', default: 0 })
    bestDifficulty: number

    @Column({ default: 0, type: 'decimal' })
    hashRate: number;

    @OneToMany(
        () => ClientStatisticsEntity,
        clientStatisticsEntity => clientStatisticsEntity.client
    )
    statistics: ClientStatisticsEntity[]

}
