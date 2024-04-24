import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ClientEntity } from './client.entity';
import { ClientService } from './client.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ClientEntity])],
  providers: [ClientService],
  exports: [TypeOrmModule, ClientService],
})
export class ClientModule {}
