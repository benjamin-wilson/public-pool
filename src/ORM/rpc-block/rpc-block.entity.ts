import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity()
export class RpcBlockEntity {

    @PrimaryColumn()
    blockHeight: number;

    @Column({ nullable: true })
    data?: string;
}