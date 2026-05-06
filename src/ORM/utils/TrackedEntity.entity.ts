import { CreateDateColumn, DeleteDateColumn, UpdateDateColumn } from 'typeorm';

export abstract class TrackedEntity {
    @DeleteDateColumn({ nullable: true })
    public deletedAt?: Date;

    @CreateDateColumn()
    public createdAt?: Date

    @UpdateDateColumn()
    public updatedAt?: Date
}
