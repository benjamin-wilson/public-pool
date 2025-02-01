import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ShareSubmissionsEntity } from './share-submissions.entity';
import { ShareSubmissionsService } from './share-submissions.service';

@Global()
@Module({
    imports: [TypeOrmModule.forFeature([ShareSubmissionsEntity])],
    providers: [ShareSubmissionsService],
    exports: [TypeOrmModule, ShareSubmissionsService],
})
export class ShareSubmissionsModule { } 
