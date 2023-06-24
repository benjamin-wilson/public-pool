import { Controller, Get, Param } from '@nestjs/common';

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

  @Get('client/:clientId')
  async getClientInfo(@Param('clientId') clientId: string) {

    const workers = await this.clientService.getByAddress(clientId);

    //const workers = this.stratumV1Service.clients.filter(client => client.clientAuthorization.address === clientId);
    return {
      workersCount: workers.length,
      workers: await Promise.all(
        workers.map(async (worker) => {
          return {
            id: worker.id,
            name: worker.clientName,
            bestDifficulty: Math.floor(worker.bestDifficulty),
            hashRate: Math.floor(await this.clientStatisticsService.getHashRate(worker.id)),
            startTime: worker.startTime
          };
        })
      )
    }
  }

  @Get('client/:clientId/:workerId')
  async getWorkerInfo(@Param('clientId') clientId: string, @Param('workerId') workerId: string) {

    const worker = await this.clientService.getByAddressAndName(clientId, workerId);

    //const worker = this.stratumV1Service.clients.find(client => client.clientAuthorization.address === clientId && client.id === workerId);
    return {
      id: worker.id,
      name: worker.clientName,
      bestDifficulty: Math.floor(worker.bestDifficulty),
      //hashData: worker.statistics.historicSubmissions,
      startTime: worker.startTime
    }
  }
}
