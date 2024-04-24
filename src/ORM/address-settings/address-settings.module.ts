import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AddressSettingsEntity } from './address-settings.entity';
import { AddressSettingsService } from './address-settings.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AddressSettingsEntity])],
  providers: [AddressSettingsService],
  exports: [TypeOrmModule, AddressSettingsService],
})
export class AddressSettingsModule {}
