import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AddressSettingsEntity } from './address-settings.entity';

@Injectable()
export class AddressSettingsService {

    constructor(
        @InjectRepository(AddressSettingsEntity)
        private addressSettingsRepository: Repository<AddressSettingsEntity>
    ) {

    }

}