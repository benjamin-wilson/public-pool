import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AcceptedShareEntity } from '../accepted-share/accepted-share.entity';
import { ShareAccountingService } from './share-accounting.service';

@Global()
@Module({
    imports: [TypeOrmModule.forFeature([AcceptedShareEntity])],
    providers: [ShareAccountingService],
    exports: [TypeOrmModule, ShareAccountingService],
})
export class ShareAccountingModule { }
