import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AcceptedShareEntity } from '../accepted-share/accepted-share.entity';
import { AddressSettingsEntity } from '../address-settings/address-settings.entity';
import { ShareAccountingService } from './share-accounting.service';

@Global()
@Module({
    imports: [TypeOrmModule.forFeature([AcceptedShareEntity, AddressSettingsEntity])],
    providers: [ShareAccountingService],
    exports: [TypeOrmModule, ShareAccountingService],
})
export class ShareAccountingModule { }
