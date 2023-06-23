import { Controller, Get, Param } from '@nestjs/common';

import { AppService } from './app.service';
import { StratumV1Service } from './stratum-v1.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService, private readonly stratumV1Service: StratumV1Service) { }

  @Get()
  getInfo() {
    return {
      clients: this.stratumV1Service.clients.length
    }
  }

  @Get('client/:clientId')
  getClientInfo(@Param('clientId') clientId: string) {
    const workers = this.stratumV1Service.clients.filter(client => client.clientAuthorization.address === clientId);
    return {
      workersCount: workers.length,
      workers: workers.map(worker => {
        return {
          id: worker.id,
          name: worker.clientAuthorization.worker,
          bestDifficulty: Math.floor(worker.statistics.bestDifficulty),
          hashRate: Math.floor(worker.statistics.getHashRate()),
          startTime: worker.startTime
        }
      })
    }
  }

  @Get('client/:clientId/:workerId')
  getWorkerInfo(@Param('clientId') clientId: string, @Param('workerId') workerId: string) {
    const worker = this.stratumV1Service.clients.find(client => client.clientAuthorization.address === clientId && client.id === workerId);
    return {
      id: worker.id,
      name: worker.clientAuthorization.worker,
      bestDifficulty: Math.floor(worker.statistics.bestDifficulty),
      hashData: worker.statistics.historicSubmissions,
      startTime: worker.startTime
    }
  }
}
