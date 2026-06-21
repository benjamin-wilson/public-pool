import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';

import { AddressSettingsService } from '../../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../../ORM/client/client.service';
import { PayoutSnapshotService } from '../../ORM/payout-snapshot/payout-snapshot.service';
import { ShareAccountingService } from '../../ORM/share-accounting/share-accounting.service';
import { normalizePayoutMode, PayoutMode } from '../../types/payout-mode';

const DEFAULT_CLIENT_ACTIVE_WINDOW_MS = 30 * 60 * 1000;

@Controller('client')
export class ClientController {
    private readonly activeWindowMs = this.readPositiveInt('CLIENT_REPORT_ACTIVE_WINDOW_MS', DEFAULT_CLIENT_ACTIVE_WINDOW_MS);

    constructor(
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly addressSettingsService: AddressSettingsService,
        private readonly shareAccountingService: ShareAccountingService,
        private readonly payoutSnapshotService: PayoutSnapshotService,
    ) { }


    @Get(':address')
    async getClientInfo(@Param('address') address: string, @Query('payoutMode') payoutMode?: string) {
        const mode = this.getRequestedPayoutMode(payoutMode);
        const workers = await this.getActiveAddressWorkers(address, mode);
        const sessionSummaries = await this.shareAccountingService.getSessionSummaries(workers.map(worker => worker.clientId));

        const addressSettings = process.env.API_ONLY === 'true'
            ? null
            : await this.addressSettingsService.getSettings(address, false);
        const bestDifficulty = addressSettings?.bestDifficulty ?? workers.reduce((best, worker) => {
            return Math.max(best, Number(worker.bestDifficulty ?? 0));
        }, 0);
        const accountingSummary = mode == null
            ? await this.shareAccountingService.getAddressSummary(address)
            : await this.shareAccountingService.getAddressSummary(address, mode);
        const accounting = this.withBestSubmissionDifficulty(accountingSummary, bestDifficulty);
        const expectedPayout = mode === 'solo'
            ? null
            : await this.payoutSnapshotService.getLatestExpectedPayoutForAddress(address);

        const response = {
            bestDifficulty,
            workersCount: workers.length,
            accounting,
            expectedPayout,
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
                        payoutMode: worker.payoutMode,
                        bestDifficulty: bestDifficulty.toFixed(2),
                        hashRate: sessionSummary?.hashRateLast10Minutes ?? worker.hashRate,
                        startTime: worker.startTime,
                        lastSeen: sessionSummary?.latestShareAt ?? worker.lastSeen
                    };
                })
            )
        }
        return response;
    }

    @Get(':address/chart')
    async getClientInfoChart(@Param('address') address: string) {
        return await this.clientStatisticsService.getChartDataForAddress(address);
    }

    @Get(':address/chart/payout-modes')
    async getClientInfoChartByPayoutMode(@Param('address') address: string, @Query('payoutMode') payoutMode?: string) {
        const mode = this.getRequestedPayoutMode(payoutMode);
        return await this.clientStatisticsService.getChartDataForAddressByPayoutMode(address, mode);
    }

    @Get(':address/:workerName')
    async getWorkerGroupInfo(@Param('address') address: string, @Param('workerName') workerName: string, @Query('payoutMode') payoutMode?: string) {
        const mode = this.getRequestedPayoutMode(payoutMode);
        const addressWorkers = await this.getActiveAddressWorkers(address, mode);
        const workers = addressWorkers
            .filter(worker => worker.clientName === workerName);

        const bestDifficulty = workers.reduce((pre, cur, idx, arr) => {
            if (cur.bestDifficulty > pre) {
                return cur.bestDifficulty;
            }
            return pre;
        }, 0);

        const chartData = await this.clientStatisticsService.getChartDataForGroup(address, workerName);
        const chartDataByPayoutMode = await this.clientStatisticsService.getChartDataForGroupByPayoutMode(address, workerName, mode);
        const accountingSummary = mode == null
            ? await this.shareAccountingService.getWorkerGroupSummary(address, workerName)
            : await this.shareAccountingService.getWorkerGroupSummary(address, workerName, mode);
        const accounting = this.withBestSubmissionDifficulty(accountingSummary, bestDifficulty);
        const response = {

            name: workerName,
            bestDifficulty: Math.floor(bestDifficulty),
            payoutModes: [...new Set(workers.map(worker => worker.payoutMode))],
            accounting,
            chartData: chartData,
            chartDataByPayoutMode,

        }
        return response;
    }

    @Get(':address/:workerName/:sessionId')
    async getWorkerInfo(@Param('address') address: string, @Param('workerName') workerName: string, @Param('sessionId') sessionId: string, @Query('payoutMode') payoutMode?: string) {
        const mode = this.getRequestedPayoutMode(payoutMode);
        const addressWorkers = await this.getActiveAddressWorkers(address, mode);
        const presenceWorker = addressWorkers
            .find(worker => worker.clientName === workerName && worker.sessionId === sessionId);
        const worker = presenceWorker == null
            ? await this.clientService.getBySessionId(address, workerName, sessionId)
            : {
                id: presenceWorker.clientId,
                sessionId: presenceWorker.sessionId,
                clientName: presenceWorker.clientName,
                bestDifficulty: presenceWorker.bestDifficulty,
                payoutMode: presenceWorker.payoutMode,
                startTime: presenceWorker.startTime,
            };
        if (worker == null) {
            return new NotFoundException();
        }
        const chartData = await this.clientStatisticsService.getChartDataForSession(worker.id);
        const chartDataByPayoutMode = await this.clientStatisticsService.getChartDataForSessionByPayoutMode(worker.id, mode);
        const accounting = this.withBestSubmissionDifficulty(
            mode == null
                ? await this.shareAccountingService.getSessionSummary(worker.id)
                : await this.shareAccountingService.getSessionSummary(worker.id, mode),
            worker.bestDifficulty,
        );

        const response = {
            sessionId: worker.sessionId,
            name: worker.clientName,
            bestDifficulty: Math.floor(worker.bestDifficulty),
            payoutMode: worker.payoutMode,
            accounting,
            chartData: chartData,
            chartDataByPayoutMode,
            startTime: worker.startTime
        }
        return response;
    }

    private withBestSubmissionDifficulty<T extends { bestSubmissionDifficulty?: number }>(
        accounting: T,
        fallbackBestDifficulty: unknown,
    ): T {
        const existing = Number(accounting?.bestSubmissionDifficulty ?? 0);
        const fallback = Number(fallbackBestDifficulty ?? 0);

        if (!Number.isFinite(fallback) || fallback <= existing) {
            return accounting;
        }

        return {
            ...accounting,
            bestSubmissionDifficulty: fallback,
        };
    }

    private getRequestedPayoutMode(payoutMode?: string): PayoutMode | undefined {
        if (payoutMode == null || payoutMode === 'all') {
            return undefined;
        }
        return normalizePayoutMode(payoutMode);
    }

    private async getActiveAddressWorkers(address: string, payoutMode?: PayoutMode) {
        const workers = await this.clientService.getByAddress(address);
        const activeSince = Date.now() - this.activeWindowMs;
        return workers
            .filter(worker => payoutMode == null || worker.payoutMode === payoutMode)
            .filter(worker => worker.deletedAt == null)
            .filter(worker => Number(worker.hashRate ?? 0) > 0)
            .filter(worker => {
                const updatedAt = worker.updatedAt == null ? 0 : new Date(worker.updatedAt).getTime();
                return Number.isFinite(updatedAt) && updatedAt > activeSince;
            })
            .map(worker => ({
                clientId: worker.id,
                address: worker.address,
                clientName: worker.clientName,
                sessionId: worker.sessionId,
                payoutMode: worker.payoutMode,
                userAgent: worker.userAgent,
                startTime: worker.startTime,
                lastSeen: worker.updatedAt,
                hashRate: Number(worker.hashRate ?? 0),
                bestDifficulty: Number(worker.bestDifficulty ?? 0),
            }));
    }

    private readPositiveInt(name: string, defaultValue: number): number {
        const value = Number(process.env[name]);
        if (Number.isInteger(value) && value > 0) {
            return value;
        }
        return defaultValue;
    }
}
