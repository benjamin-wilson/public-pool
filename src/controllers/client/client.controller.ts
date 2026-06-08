import { Controller, Get, NotFoundException, Param } from '@nestjs/common';

import { AddressSettingsService } from '../../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../../ORM/client/client.service';
import { ShareAccountingService } from '../../ORM/share-accounting/share-accounting.service';
import { RedisMessagingService } from '../../services/redis-messaging.service';
import { logTiming, timeAsync, timingStart } from '../../utils/timing.utils';


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
        const start = timingStart();

        const workers = await timeAsync('/api/client/:address presence', () => this.redisMessagingService.getClientPresenceByAddress(address), { address });
        const sessionSummaries = await timeAsync('/api/client/:address session summaries', () => this.shareAccountingService.getSessionSummaries(workers.map(worker => worker.clientId)), { address, workers: workers.length });

        const addressSettings = process.env.API_ONLY === 'true'
            ? null
            : await timeAsync('/api/client/:address address settings', () => this.addressSettingsService.getSettings(address, false), { address });
        const accounting = await timeAsync('/api/client/:address accounting', () => this.shareAccountingService.getAddressSummary(address), { address });
        const bestDifficulty = addressSettings?.bestDifficulty ?? workers.reduce((best, worker) => {
            return Math.max(best, Number(worker.bestDifficulty ?? 0));
        }, 0);

        const response = {
            bestDifficulty,
            workersCount: workers.length,
            accounting,
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
        logTiming('GET /api/client/:address', start, { address, workers: workers.length });
        return response;
    }

    @Get(':address/chart')
    async getClientInfoChart(@Param('address') address: string) {
        const start = timingStart();
        const chartData = await timeAsync('/api/client/:address/chart query', () => this.clientStatisticsService.getChartDataForAddress(address), { address });
        logTiming('GET /api/client/:address/chart', start, { address, points: chartData.length });
        return chartData;
    }

    @Get(':address/:workerName')
    async getWorkerGroupInfo(@Param('address') address: string, @Param('workerName') workerName: string) {
        const start = timingStart();

        const addressWorkers = await timeAsync('/api/client/:address/:workerName address presence', () => this.redisMessagingService.getClientPresenceByAddress(address), { address, workerName });
        const workers = addressWorkers
            .filter(worker => worker.clientName === workerName);

        const bestDifficulty = workers.reduce((pre, cur, idx, arr) => {
            if (cur.bestDifficulty > pre) {
                return cur.bestDifficulty;
            }
            return pre;
        }, 0);

        const chartData = await timeAsync('/api/client/:address/:workerName chart', () => this.clientStatisticsService.getChartDataForGroup(address, workerName), { address, workerName });
        const accounting = await timeAsync('/api/client/:address/:workerName accounting', () => this.shareAccountingService.getWorkerGroupSummary(address, workerName), { address, workerName });
        const response = {

            name: workerName,
            bestDifficulty: Math.floor(bestDifficulty),
            accounting,
            chartData: chartData,

        }
        logTiming('GET /api/client/:address/:workerName', start, { address, workerName, addressWorkers: addressWorkers.length, matchedWorkers: workers.length, points: chartData.length });
        return response;
    }

    @Get(':address/:workerName/:sessionId')
    async getWorkerInfo(@Param('address') address: string, @Param('workerName') workerName: string, @Param('sessionId') sessionId: string) {
        const start = timingStart();

        const addressWorkers = await timeAsync('/api/client/:address/:workerName/:sessionId address presence', () => this.redisMessagingService.getClientPresenceByAddress(address), { address, workerName, sessionId });
        const presenceWorker = addressWorkers
            .find(worker => worker.clientName === workerName && worker.sessionId === sessionId);
        const worker = presenceWorker == null
            ? await timeAsync('/api/client/:address/:workerName/:sessionId DB fallback', () => this.clientService.getBySessionId(address, workerName, sessionId), { address, workerName, sessionId })
            : {
                id: presenceWorker.clientId,
                sessionId: presenceWorker.sessionId,
                clientName: presenceWorker.clientName,
                bestDifficulty: presenceWorker.bestDifficulty,
                startTime: presenceWorker.startTime,
            };
        if (worker == null) {
            logTiming('GET /api/client/:address/:workerName/:sessionId', start, { address, workerName, sessionId, found: false, addressWorkers: addressWorkers.length });
            return new NotFoundException();
        }
        const chartData = await timeAsync('/api/client/:address/:workerName/:sessionId chart', () => this.clientStatisticsService.getChartDataForSession(worker.id), { address, workerName, sessionId, clientId: worker.id });
        const accounting = await timeAsync('/api/client/:address/:workerName/:sessionId accounting', () => this.shareAccountingService.getSessionSummary(worker.id), { address, workerName, sessionId, clientId: worker.id });

        const response = {
            sessionId: worker.sessionId,
            name: worker.clientName,
            bestDifficulty: Math.floor(worker.bestDifficulty),
            accounting,
            chartData: chartData,
            startTime: worker.startTime
        }
        logTiming('GET /api/client/:address/:workerName/:sessionId', start, { address, workerName, sessionId, found: true, addressWorkers: addressWorkers.length, points: chartData.length });
        return response;
    }
}
