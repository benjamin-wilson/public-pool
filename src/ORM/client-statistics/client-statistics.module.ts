import { Global, Module } from '@nestjs/common';

import { ClientStatisticsService } from './client-statistics.service';


@Global()
@Module({
    providers: [ClientStatisticsService],
    exports: [ClientStatisticsService],
})
export class ClientStatisticsModule { }
