import { CreateDateColumn, DeleteDateColumn, UpdateDateColumn } from 'typeorm';

export abstract class TrackedEntity {
    @DeleteDateColumn({ nullable: true, type: 'datetime' })
    public deletedAt?: Date;

    @CreateDateColumn({ type: 'datetime' })
    public createdAt?: Date

    @UpdateDateColumn({ type: 'datetime' })
    public updatedAt?: Date
}