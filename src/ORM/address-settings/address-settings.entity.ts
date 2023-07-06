import { Column, Entity, PrimaryColumn } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
export class AddressSettingsEntity extends TrackedEntity {

    @PrimaryColumn({ length: 62, type: 'varchar' })
    address: string;

    @Column()
    miscCoinbaseScriptData: string;

}

