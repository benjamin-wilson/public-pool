import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ExternalSharesEntity } from './external-shares.entity';
import { ExternalSharesService } from './external-shares.service';

@Global()
@Module({
    imports: [TypeOrmModule.forFeature([ExternalSharesEntity])],
    providers: [ExternalSharesService],
    exports: [TypeOrmModule, ExternalSharesService],
})
export class ExternalSharesModule { } 
