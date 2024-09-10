import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { UserAgentReportService } from '../ORM/_views/user-agent-report/user-agent-report.service';
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
        private readonly userAgentReportService: UserAgentReportService
    ) {

    }

    async onModuleInit() {
        if (process.env.MASTER == 'true') {

            setInterval(async () => {
                await this.deleteOldStatistics();
            }, 1000 * 60 * 60);

            setInterval(async () => {
                console.log('Killing dead clients');
                await this.clientService.killDeadClients();
            }, 1000 * 60 * 5);

            setInterval(async () => {
                console.log('Deleting Old Blocks');
                await this.rpcBlockService.deleteOldBlocks();
            }, 1000 * 60 * 60 * 24);

            setInterval(async () => {
                await this.updateChart();
            }, 1000 * 60 * 10);


            setInterval(async () => {
                console.log('Refreshing user agent report view')
                await this.userAgentReportService.refreshReport();
                console.log('Finished Refreshing user agent report view')
            }, 1000 * 60 * 5);

        }

    }

    private async deleteOldStatistics() {
        console.log('Deleting statistics');

        const deletedStatistics = await this.clientStatisticsService.deleteOldStatistics();
        console.log(`Deleted ${deletedStatistics.affected} old statistics`);
        const deletedClients = await this.clientService.deleteOldClients();
        console.log(`Deleted ${deletedClients.affected} old clients`);

    }


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