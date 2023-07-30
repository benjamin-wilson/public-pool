import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Controller, Get, Inject } from '@nestjs/common';
import { Cache } from 'cache-manager';

import { BlocksService } from './ORM/blocks/blocks.service';
import { ClientStatisticsService } from './ORM/client-statistics/client-statistics.service';
import { ClientService } from './ORM/client/client.service';

@Controller()
export class AppController {
  constructor(
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private clientService: ClientService,
    private clientStatisticsService: ClientStatisticsService,
    private blocksService: BlocksService
  ) { }

  @Get('info')
  public async info() {

    const blockData = await this.blocksService.getFoundBlocks();
    const userAgents = await this.clientService.getUserAgents();

    const CACHE_KEY = 'SITE_HASHRATE_GRAPH';
    const cachedResult = await this.cacheManager.get(CACHE_KEY);
    if (cachedResult != null) {
      return {
        chartData: cachedResult,
        blockData,
        userAgents
      };
    }

    const chartData = await this.clientStatisticsService.getChartDataForSite();

    //5 min
    await this.cacheManager.set(CACHE_KEY, chartData, 5 * 60 * 1000);

    return {
      chartData,
      blockData,
      userAgents
    };
  }

}
