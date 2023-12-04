import { Injectable, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
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

    }

    @Interval(1000 * 60 * 60)
    private async deleteOldStatistics() {
        console.log('Deleting statistics');
        if (process.env.ENABLE_SOLO == 'true' && (process.env.NODE_APP_INSTANCE == null || process.env.NODE_APP_INSTANCE == '0')) {
            const deletedStatistics = await this.clientStatisticsService.deleteOldStatistics();
            console.log(`Deleted ${deletedStatistics.affected} old statistics`);
            const deletedClients = await this.clientService.deleteOldClients();
            console.log(`Deleted ${deletedClients.affected} old clients`);
        }
    }

    @Interval(1000 * 60 * 5)
    private async killDeadClients() {
        console.log('Killing dead clients');
        if (process.env.ENABLE_SOLO == 'true' && (process.env.NODE_APP_INSTANCE == null || process.env.NODE_APP_INSTANCE == '0')) {
            await this.clientService.killDeadClients();
        }
    }

}