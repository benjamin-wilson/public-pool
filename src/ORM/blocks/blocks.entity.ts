import { Column, Entity } from 'typeorm';

import { PrimaryGeneratedBigIntColumn } from '../utils/PrimaryGeneratedBigIntColumn';
import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
export class BlocksEntity extends TrackedEntity {

    @PrimaryGeneratedBigIntColumn()
    id: number;

    @Column()
    height: number;

    @Column({ length: 62, type: 'varchar' })
    minerAddress: string;

    @Column()
    worker: string;

    @Column({ length: 8, type: 'varchar' })
    sessionId: string;

    @Column()
    blockData: string;

}
