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
        //https://phiresky.github.io/blog/2020/sqlite-performance-tuning/
        //500 MB DB cache
        await this.dataSource.query(`PRAGMA cache_size = -500000;`);
        //Normal is still completely corruption safe in WAL mode, and means only WAL checkpoints have to wait for FSYNC. 
        await this.dataSource.query(`PRAGMA synchronous = normal;`);
        //3Gb
        await this.dataSource.query(`PRAGMA mmap_size = 3000000000;`);
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

    @Cron(CronExpression.EVERY_10_MINUTES)
    private async killDeadClients() {

        if (process.env.NODE_APP_INSTANCE == null || process.env.NODE_APP_INSTANCE == '0') {
            await this.clientService.killDeadClients();
        }
    }
}