import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BlocksEntity } from './blocks.entity';
import { BlocksService } from './blocks.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([BlocksEntity])],
  providers: [BlocksService],
  exports: [TypeOrmModule, BlocksService],
})
export class BlocksModule {}
