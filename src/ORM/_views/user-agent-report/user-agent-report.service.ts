import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UserAgentReportView } from './user-agent-report.view';

@Injectable()
export class UserAgentReportService {

    constructor(
        @InjectRepository(UserAgentReportView)
        private userAgentReport: Repository<UserAgentReportView>,
    ) {

    }

    public async getReport() {
        return await this.userAgentReport.find();
    }

    public async refreshReport() {
        try {
            return await this.userAgentReport.query(`
            COMMIT;
            BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
            REFRESH MATERIALIZED VIEW user_agent_report_view;
            COMMIT;
        `);
        } catch (e) {

            console.log(e)
        }

    }
}