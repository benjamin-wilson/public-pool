import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UserAgentReportService } from './user-agent-report.service';
import { UserAgentReportView } from './user-agent-report.view';
import { ClientEntity } from '../../client/client.entity';



@Global()
@Module({
    imports: [TypeOrmModule.forFeature([UserAgentReportView, ClientEntity])],
    providers: [UserAgentReportService],
    exports: [TypeOrmModule, UserAgentReportService],
})
export class UserAgentReportModule { }
