import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
@Index(['address', 'time'])
export class ExternalSharesEntity extends TrackedEntity {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ length: 62, type: 'varchar' })
    address: string;

    @Column()
    clientName: string;

    @Column({ type: 'integer' })
    time: number;

    @Column({ type: 'real' })
    difficulty: number;

    @Column({ length: 128, type: 'varchar', nullable: true })
    userAgent: string;

    @Column({ length: 128, type: 'varchar', nullable: true })
    externalPoolName: string;

    @Column()
    header: string;
}
