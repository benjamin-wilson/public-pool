import { Injectable, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';

import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';

@Injectable()
export class AppService implements OnModuleInit {

    constructor(
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly clientService: ClientService,
        private readonly dataSource: DataSource
    ) {

    }

    async onModuleInit() {
        //100 MB DB cache
        await this.dataSource.query(`PRAGMA cache_size = -100000`);
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