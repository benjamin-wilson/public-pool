import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AddressSettingsModule } from '../../ORM/address-settings/address-settings.module';
import { ClientStatisticsModule } from '../../ORM/client-statistics/client-statistics.module';
import { ClientModule } from '../../ORM/client/client.module';
import { ClientController } from './client.controller';

describe('ClientController', () => {
  let controller: ClientController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: './DB/public-pool.test.sqlite',
          synchronize: true,
          autoLoadEntities: true,
          cache: true,
          logging: false,
        }),
        AddressSettingsModule,
        ClientModule,
        ClientStatisticsModule,
      ],
      controllers: [ClientController],
    }).compile();

    controller = module.get<ClientController>(ClientController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
