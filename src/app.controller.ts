import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Controller, Get, Inject } from '@nestjs/common';
import { Cache } from 'cache-manager';
import { firstValueFrom } from 'rxjs';

import { BlocksService } from './ORM/blocks/blocks.service';
import { ClientStatisticsService } from './ORM/client-statistics/client-statistics.service';
import { ClientService } from './ORM/client/client.service';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';

@Controller()
export class AppController {
  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly clientService: ClientService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly blocksService: BlocksService,
    private readonly bitcoinRpcService: BitcoinRpcService
  ) { }

  @Get('info')
  public async info() {

    const blockData = await this.blocksService.getFoundBlocks();
    const userAgents = await this.clientService.getUserAgents();

    return {
      blockData,
      userAgents
    };
  }

  @Get('network')
  public async network() {
    const miningInfo = await firstValueFrom(this.bitcoinRpcService.newBlock$);
    return miningInfo;
  }

  @Get('info/chart')
  public async infoChart() {


    // const CACHE_KEY = 'SITE_HASHRATE_GRAPH';
    // const cachedResult = await this.cacheManager.get(CACHE_KEY);

    // if (cachedResult != null) {
    //   return cachedResult;
    // }

    const chartData = await this.clientStatisticsService.getChartDataForSite();

    //5 min
    //await this.cacheManager.set(CACHE_KEY, chartData, 5 * 60 * 1000);

    return chartData;


  }

}
