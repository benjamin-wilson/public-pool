import { Controller, Get, NotFoundException, Param } from '@nestjs/common';

import { AddressSettingsService } from '../../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../../ORM/client/client.service';

@Controller('client')
export class ClientController {
  constructor(
    private readonly clientService: ClientService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly addressSettingsService: AddressSettingsService,
  ) {}

  @Get(':address')
  async getClientInfo(@Param('address') address: string) {
    const workers = await this.clientService.getByAddress(address);

    const addressSettings = await this.addressSettingsService.getSettings(
      address,
      false,
    );

    return {
      bestDifficulty: addressSettings?.bestDifficulty,
      workersCount: workers.length,
      workers: await Promise.all(
        workers.map(async (worker) => {
          return {
            sessionId: worker.sessionId,
            name: worker.clientName,
            bestDifficulty: worker.bestDifficulty.toFixed(2),
            hashRate: worker.hashRate,
            startTime: worker.startTime,
            lastSeen: worker.updatedAt,
          };
        }),
      ),
    };
  }

  @Get(':address/chart')
  async getClientInfoChart(@Param('address') address: string) {
    const chartData = await this.clientStatisticsService.getChartDataForAddress(
      address,
    );
    return chartData;
  }

  @Get(':address/:workerName')
  async getWorkerGroupInfo(
    @Param('address') address: string,
    @Param('workerName') workerName: string,
  ) {
    const workers = await this.clientService.getByName(address, workerName);

    const bestDifficulty = workers.reduce((pre, cur, idx, arr) => {
      if (cur.bestDifficulty > pre) {
        return cur.bestDifficulty;
      }
      return pre;
    }, 0);

    const chartData = await this.clientStatisticsService.getChartDataForGroup(
      address,
      workerName,
    );
    return {
      name: workerName,
      bestDifficulty: Math.floor(bestDifficulty),
      chartData: chartData,
    };
  }

  @Get(':address/:workerName/:sessionId')
  async getWorkerInfo(
    @Param('address') address: string,
    @Param('workerName') workerName: string,
    @Param('sessionId') sessionId: string,
  ) {
    const worker = await this.clientService.getBySessionId(
      address,
      workerName,
      sessionId,
    );
    if (worker == null) {
      return new NotFoundException();
    }
    const chartData = await this.clientStatisticsService.getChartDataForSession(
      worker.address,
      worker.clientName,
      worker.sessionId,
    );

    return {
      sessionId: worker.sessionId,
      name: worker.clientName,
      bestDifficulty: Math.floor(worker.bestDifficulty),
      chartData: chartData,
      startTime: worker.startTime,
    };
  }
}
