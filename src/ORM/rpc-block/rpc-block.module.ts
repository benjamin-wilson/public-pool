import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RpcBlockEntity } from './rpc-block.entity';
import { RpcBlockService } from './rpc-block.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([RpcBlockEntity])],
  providers: [RpcBlockService],
  exports: [TypeOrmModule, RpcBlockService],
})
export class RpcBlocksModule {}
