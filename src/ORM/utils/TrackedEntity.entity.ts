import { CreateDateColumn, DeleteDateColumn, UpdateDateColumn } from 'typeorm';

export abstract class TrackedEntity {
    @DeleteDateColumn({ nullable: true, type: 'timestamptz' })
    public deletedAt?: Date;

    @CreateDateColumn({ type: 'timestamptz' })
    public createdAt?: Date

    @UpdateDateColumn({ type: 'timestamptz' })
    public updatedAt?: Date
}