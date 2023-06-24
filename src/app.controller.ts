import { Controller, Get, NotFoundException, Param } from '@nestjs/common';

import { AppService } from './app.service';
import { ClientStatisticsService } from './ORM/client-statistics/client-statistics.service';
import { ClientService } from './ORM/client/client.service';
import { StratumV1Service } from './stratum-v1.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly stratumV1Service: StratumV1Service,
    private readonly clientService: ClientService,
    private readonly clientStatisticsService: ClientStatisticsService
  ) { }

  @Get()
  async getInfo() {
    return {
      clients: await this.clientService.connectedClientCount()
    }
  }

  @Get('client/:address')
  async getClientInfo(@Param('address') address: string) {

    const workers = await this.clientService.getByAddress(address);


    return {
      workersCount: workers.length,
      workers: await Promise.all(
        workers.map(async (worker) => {
          return {
            sessionId: worker.sessionId,
            name: worker.clientName,
            bestDifficulty: Math.floor(worker.bestDifficulty),
            hashRate: Math.floor(await this.clientStatisticsService.getHashRate(worker.sessionId)),
            startTime: worker.startTime
          };
        })
      )
    }
  }

  @Get('client/:address/:workerName')
  async getWorkerGroupInfo(@Param('address') address: string, @Param('address') workerName: string) {

  }

  @Get('client/:address/:workerName/:sessionId')
  async getWorkerInfo(@Param('address') address: string, @Param('workerName') workerName: string, @Param('sessionId') sessionId: string) {

    const worker = await this.clientService.getById(address, workerName, sessionId);
    if (worker == null) {
      return new NotFoundException();
    }
    const chartData = await this.clientStatisticsService.getChartData(sessionId);

    return {
      sessionId: worker.sessionId,
      name: worker.clientName,
      bestDifficulty: Math.floor(worker.bestDifficulty),
      chartData: chartData,
      startTime: worker.startTime
    }
  }
}
