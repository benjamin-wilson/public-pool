import { Column, Entity } from 'typeorm';

import { PrimaryGeneratedBigIntColumn } from '../utils/PrimaryGeneratedBigIntColumn';

@Entity()
export class HomeGraphEntity {

    @PrimaryGeneratedBigIntColumn()
    id: number;

    @Column({ type: 'bigint' })
    label: number;

    @Column({ type: 'bigint' })
    data: number;
}
