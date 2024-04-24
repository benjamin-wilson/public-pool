import { Column, Entity, PrimaryColumn } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
export class AddressSettingsEntity extends TrackedEntity {
  @PrimaryColumn({ length: 62, type: 'varchar' })
  address: string;

  @Column({ default: 0 })
  shares: number;

  @Column({ type: 'real', default: 0 })
  bestDifficulty: number;

  @Column({ nullable: true })
  miscCoinbaseScriptData: string;

  @Column({ nullable: true })
  bestDifficultyUserAgent: string;
}
