import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
export class TelegramSubscriptionsEntity extends TrackedEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ length: 62, type: 'varchar' })
  address: string;

  @Column()
  telegramChatId: number;
}
