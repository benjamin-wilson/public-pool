import { Controller, Get, NotFoundException, Param } from '@nestjs/common';

import { AddressSettingsService } from '../../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../../ORM/client/client.service';
import { ShareAccountingService } from '../../ORM/share-accounting/share-accounting.service';
import { RedisMessagingService } from '../../services/redis-messaging.service';


@Controller('client')
export class ClientController {

    constructor(
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly addressSettingsService: AddressSettingsService,
        private readonly shareAccountingService: ShareAccountingService,
        private readonly redisMessagingService: RedisMessagingService
    ) { }


    @Get(':address')
    async getClientInfo(@Param('address') address: string) {

        const workers = await this.redisMessagingService.getClientPresenceByAddress(address);
        const sessionSummaries = await this.shareAccountingService.getSessionSummaries(workers.map(worker => worker.clientId));

        const addressSettings = await this.addressSettingsService.getSettings(address, false);

        return {
            bestDifficulty: addressSettings?.bestDifficulty,
            workersCount: workers.length,
            accounting: await this.shareAccountingService.getAddressSummary(address),
            workers: await Promise.all(
                workers.map(async (worker) => {
                    const sessionSummary = sessionSummaries.get(worker.clientId);
                    const bestDifficulty = Math.max(
                        Number(worker.bestDifficulty ?? 0),
                        Number(sessionSummary?.bestSubmissionDifficulty ?? 0),
                    );
                    return {
                        sessionId: worker.sessionId,
                        name: worker.clientName,
                        bestDifficulty: bestDifficulty.toFixed(2),
                        hashRate: sessionSummary?.hashRateLast10Minutes ?? worker.hashRate,
                        startTime: worker.startTime,
                        lastSeen: sessionSummary?.latestShareAt ?? worker.lastSeen
                    };
                })
            )
        }
    }

    @Get(':address/chart')
    async getClientInfoChart(@Param('address') address: string) {
        const chartData = await this.clientStatisticsService.getChartDataForAddress(address);
        return chartData;
    }

    @Get(':address/:workerName')
    async getWorkerGroupInfo(@Param('address') address: string, @Param('workerName') workerName: string) {

        const workers = (await this.redisMessagingService.getClientPresenceByAddress(address))
            .filter(worker => worker.clientName === workerName);

        const bestDifficulty = workers.reduce((pre, cur, idx, arr) => {
            if (cur.bestDifficulty > pre) {
                return cur.bestDifficulty;
            }
            return pre;
        }, 0);

        const chartData = await this.clientStatisticsService.getChartDataForGroup(address, workerName);
        return {

            name: workerName,
            bestDifficulty: Math.floor(bestDifficulty),
            accounting: await this.shareAccountingService.getWorkerGroupSummary(address, workerName),
            chartData: chartData,

        }
    }

    @Get(':address/:workerName/:sessionId')
    async getWorkerInfo(@Param('address') address: string, @Param('workerName') workerName: string, @Param('sessionId') sessionId: string) {

        const presenceWorker = (await this.redisMessagingService.getClientPresenceByAddress(address))
            .find(worker => worker.clientName === workerName && worker.sessionId === sessionId);
        const worker = presenceWorker == null
            ? await this.clientService.getBySessionId(address, workerName, sessionId)
            : {
                id: presenceWorker.clientId,
                sessionId: presenceWorker.sessionId,
                clientName: presenceWorker.clientName,
                bestDifficulty: presenceWorker.bestDifficulty,
                startTime: presenceWorker.startTime,
            };
        if (worker == null) {
            return new NotFoundException();
        }
        const chartData = await this.clientStatisticsService.getChartDataForSession(worker.id);

        return {
            sessionId: worker.sessionId,
            name: worker.clientName,
            bestDifficulty: Math.floor(worker.bestDifficulty),
            accounting: await this.shareAccountingService.getSessionSummary(worker.id),
            chartData: chartData,
            startTime: worker.startTime
        }
    }
}
