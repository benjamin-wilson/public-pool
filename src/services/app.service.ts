import { Injectable, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DataSource } from 'typeorm';

import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { HomeGraphService } from '../ORM/home-graph/home-graph.service';
import { RpcBlockService } from '../ORM/rpc-block/rpc-block.service';

@Injectable()
export class AppService implements OnModuleInit {

    constructor(
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly clientService: ClientService,
        private readonly rpcBlockService: RpcBlockService,
        private readonly homeGraphService: HomeGraphService,
        private readonly dataSource: DataSource,
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

    @Interval(1000 * 60 * 60 * 24)
    private async deleteOldBlocks() {
        console.log('Deleting Old Blocks');
        if (process.env.ENABLE_SOLO == 'true' && (process.env.NODE_APP_INSTANCE == null || process.env.NODE_APP_INSTANCE == '0')) {
            await this.rpcBlockService.deleteOldBlocks();
        }
    }

    @Interval(1000 * 60 * 10)
    private async updateChart() {
        console.log('Updating Chart');

        const latestGraphUpdate = await this.homeGraphService.getLatestTime();


        const data = await this.dataSource.query(`
            SELECT
                time AS label,
                ROUND(((SUM(shares) * 4294967296) / 600)) AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.time > ${latestGraphUpdate.getTime()}
            GROUP BY
                time
            ORDER BY
                time
            LIMIT 144;
        `)

        console.log(`Fetched ${data.length} rows`);

        if (data.length < 2) {
            return;
        }

        const result = data.slice(0, data.length - 1);

        this.homeGraphService.save(result);

    }
}