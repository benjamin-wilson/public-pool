import { Injectable, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';

@Injectable()
export class CleanupService implements OnModuleInit {

    constructor(
        private clientStatisticsService: ClientStatisticsService,
        private clientService: ClientService
    ) {

    }
    onModuleInit() {
        console.log('Cleanup service running.')
    }

    @Cron(CronExpression.EVERY_HOUR)
    private async deleteOldStatistics() {
        if (process.env.NODE_APP_INSTANCE == null || process.env.NODE_APP_INSTANCE == '0') {
            const deletedStatistics = await this.clientStatisticsService.deleteOldStatistics();
            console.log(`Deleted ${deletedStatistics.affected} old statistics`);
            const deletedClients = await this.clientService.deleteOldClients();
            console.log(`Deleted ${deletedClients.affected} old clients`);
        }
    }
}