import { CreateDateColumn, DeleteDateColumn, UpdateDateColumn } from 'typeorm';

export abstract class TrackedEntity {
    @DeleteDateColumn({ nullable: true, type: 'timestamp' })
    public deletedAt?: Date;

    @CreateDateColumn({ type: 'timestamp' })
    public createdAt?: Date

    @UpdateDateColumn({ type: 'timestamp' })
    public updatedAt?: Date
}