import { Injectable, OnModuleInit } from '@nestjs/common';

import { UserAgentReportService } from '../ORM/_views/user-agent-report/user-agent-report.service';
import { ClientService } from '../ORM/client/client.service';
import { RpcBlockService } from '../ORM/rpc-block/rpc-block.service';
import { ShareAccountingService } from '../ORM/share-accounting/share-accounting.service';

@Injectable()
export class AppService implements OnModuleInit {
    private refreshingLiveUserAgentReport = false;
    private refreshingPoolSummary = false;

    constructor(
        private readonly clientService: ClientService,
        private readonly rpcBlockService: RpcBlockService,
        private readonly userAgentReportService: UserAgentReportService,
        private readonly shareAccountingService: ShareAccountingService
    ) {

    }

    async onModuleInit() {
        if (process.env.MASTER == 'true') {

            setInterval(async () => {
                await this.deleteOldClients();
            }, 1000 * 60 * 60);

            setInterval(async () => {
                console.log('Deleting Old Blocks');
                await this.rpcBlockService.deleteOldBlocks();
            }, 1000 * 60 * 60 * 24);

            setInterval(async () => {
                await this.refreshLiveUserAgentReport();
            }, 1000 * 30);

            setTimeout(async () => {
                await this.refreshLiveUserAgentReport();
                await this.refreshPoolSummary();
            }, 1000 * 15);

            setInterval(async () => {
                await this.refreshPoolSummary();
            }, 1000 * 60 * 5);

            setInterval(async () => {
                console.log('Refreshing user agent report view')
                await this.userAgentReportService.refreshReport();
                console.log('Finished Refreshing user agent report view')
            }, 1000 * 60 * 5);

        }
    }

    private async deleteOldClients() {
        console.log('Deleting old clients');

        const deletedClients = await this.clientService.deleteOldClients();
        console.log(`Deleted ${deletedClients.affected} old clients`);

    }

    private async refreshLiveUserAgentReport() {
        if (this.refreshingLiveUserAgentReport) {
            return;
        }

        this.refreshingLiveUserAgentReport = true;
        try {
            await this.userAgentReportService.refreshLiveReport();
        } catch (error) {
            console.error(`Failed refreshing live user agent report: ${error.message}`);
        } finally {
            this.refreshingLiveUserAgentReport = false;
        }
    }

    private async refreshPoolSummary() {
        if (this.refreshingPoolSummary) {
            return;
        }

        this.refreshingPoolSummary = true;
        try {
            await this.shareAccountingService.refreshPoolSummary();
        } catch (error) {
            console.error(`Failed refreshing pool accounting summary: ${error.message}`);
        } finally {
            this.refreshingPoolSummary = false;
        }
    }
}
