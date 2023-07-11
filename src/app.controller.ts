import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Controller, Get, Inject } from '@nestjs/common';
import { Cache } from 'cache-manager';

import { ClientStatisticsService } from './ORM/client-statistics/client-statistics.service';
import { ClientService } from './ORM/client/client.service';

@Controller()
export class AppController {
  constructor(
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private clientService: ClientService,
    private clientStatisticsService: ClientStatisticsService
  ) { }

  @Get('info')
  public async info() {

    const CACHE_KEY = 'SITE_HASHRATE_GRAPH';
    const cachedResult = await this.cacheManager.get(CACHE_KEY);
    if (cachedResult != null) {
      return {
        chartData: cachedResult
      };
    }

    const chartData = await this.clientStatisticsService.getChartDataForSite();

    await this.cacheManager.set(CACHE_KEY, chartData, 600)

    return {
      chartData
    };
  }

}
