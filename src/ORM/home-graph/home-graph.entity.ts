import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export class HomeGraphEntity {

    @PrimaryGeneratedColumn()
    id: number;

    @Column({ type: 'bigint' })
    label: number;

    @Column({ type: 'bigint' })
    data: number;
}