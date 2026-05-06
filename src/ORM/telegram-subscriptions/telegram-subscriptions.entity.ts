import { Column, Entity, Index } from 'typeorm';

import { PrimaryGeneratedBigIntColumn } from '../utils/PrimaryGeneratedBigIntColumn';
import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
export class TelegramSubscriptionsEntity extends TrackedEntity {

    @PrimaryGeneratedBigIntColumn()
    id: number;

    @Index()
    @Column({ length: 62, type: 'varchar' })
    address: string;

    @Column()
    telegramChatId: number;


}
