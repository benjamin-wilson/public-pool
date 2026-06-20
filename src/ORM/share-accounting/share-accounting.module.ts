import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AcceptedShareEntity } from '../accepted-share/accepted-share.entity';
import { ShareAccountingService } from './share-accounting.service';
import { ShareHighScoreService } from './share-high-score.service';

@Global()
@Module({
    imports: [TypeOrmModule.forFeature([AcceptedShareEntity])],
    providers: [ShareAccountingService, ShareHighScoreService],
    exports: [TypeOrmModule, ShareAccountingService, ShareHighScoreService],
})
export class ShareAccountingModule { }
