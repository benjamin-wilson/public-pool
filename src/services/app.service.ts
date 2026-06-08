import { Injectable, OnModuleInit } from '@nestjs/common';

import { UserAgentReportService } from '../ORM/_views/user-agent-report/user-agent-report.service';
import { ClientService } from '../ORM/client/client.service';
import { RpcBlockService } from '../ORM/rpc-block/rpc-block.service';

@Injectable()
export class AppService implements OnModuleInit {

    constructor(
        private readonly clientService: ClientService,
        private readonly rpcBlockService: RpcBlockService,
        private readonly userAgentReportService: UserAgentReportService
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
}
