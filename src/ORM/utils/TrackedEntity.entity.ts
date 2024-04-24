import { CreateDateColumn, DeleteDateColumn, UpdateDateColumn } from 'typeorm';

import { DateTimeTransformer } from './DateTimeTransformer';

export abstract class TrackedEntity {
  @DeleteDateColumn({
    nullable: true,
    type: 'datetime',
    transformer: new DateTimeTransformer(),
  })
  public deletedAt?: Date;

  @CreateDateColumn({
    type: 'datetime',
    transformer: new DateTimeTransformer(),
  })
  public createdAt?: Date;

  @UpdateDateColumn({
    type: 'datetime',
    transformer: new DateTimeTransformer(),
  })
  public updatedAt?: Date;
}
