import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { ClientEntity } from '../../client/client.entity';
import { UserAgentReportView } from './user-agent-report.view';
import { RedisMessagingService } from '../../../services/redis-messaging.service';

@Injectable()
export class UserAgentReportService {
    private readonly liveReportCacheKey = 'presence:user-agent-report';
    private liveRefreshPromise: Promise<UserAgentReportView[]> | null = null;

    constructor(
        @InjectRepository(UserAgentReportView)
        private userAgentReport: Repository<UserAgentReportView>,
        @InjectRepository(ClientEntity)
        private clientRepository: Repository<ClientEntity>,
        private redisMessagingService: RedisMessagingService,
    ) {

    }

    public async getReport() {
        const cachedReport = await this.redisMessagingService
            .getJsonCache<UserAgentReportView[]>(this.liveReportCacheKey)
            .catch(error => {
                console.error(`Live user-agent report cache read failed: ${error.message}`);
                return null;
            });
        if (cachedReport != null) {
            if (cachedReport.length > 0) {
                return cachedReport;
            }
        }

        if (process.env.API_ONLY == 'true') {
            const liveReport = await this.refreshLiveReport();
            if (liveReport.length > 0) {
                return liveReport;
            }

            return await this.userAgentReport.find();
        }

        return await this.refreshLiveReport();
    }

    public async refreshLiveReport() {
        if (this.liveRefreshPromise != null) {
            return this.liveRefreshPromise;
        }

        this.liveRefreshPromise = this.buildLiveReport()
            .finally(() => {
                this.liveRefreshPromise = null;
            });

        return this.liveRefreshPromise;
    }

    private async buildLiveReport() {
        const presences = await this.redisMessagingService.getAllClientPresence();
        const activePresences = await this.filterActivePresences(presences);
        if (activePresences.length === 0) {
            return await this.userAgentReport.find();
        }
        const rows = new Map<string, {
            userAgent: string;
            count: number;
            bestDifficulty: number;
            totalHashRate: number;
        }>();

        activePresences.forEach(presence => {
            const userAgent = presence.userAgent == null || presence.userAgent.length === 0
                ? 'Other'
                : presence.userAgent;
            const row = rows.get(userAgent) ?? {
                userAgent,
                count: 0,
                bestDifficulty: 0,
                totalHashRate: 0,
            };
            row.count++;
            row.bestDifficulty = Math.max(
                row.bestDifficulty,
                Number(presence.bestDifficulty ?? 0),
            );
            row.totalHashRate += Number(presence.hashRate ?? 0);
            rows.set(userAgent, row);
        });

        const report = [...rows.values()]
            .sort((left, right) => right.totalHashRate - left.totalHashRate)
            .map(row => ({
                userAgent: row.userAgent,
                count: row.count.toString(),
                bestDifficulty: row.bestDifficulty,
                totalHashRate: row.totalHashRate.toString(),
            }));

        await this.redisMessagingService
            .setJsonCache(this.liveReportCacheKey, report, 60 * 1000)
            .catch(error => {
                console.error(`Live user-agent report cache write failed: ${error.message}`);
            });

        return report;
    }

    private async filterActivePresences(presences: Awaited<ReturnType<RedisMessagingService['getAllClientPresence']>>) {
        if (presences.length === 0) {
            return [];
        }

        const activeClients = await this.clientRepository.find({
            select: {
                id: true,
            },
            where: {
                id: In(presences.map(presence => presence.clientId)),
            },
        });
        const activeIds = new Set(activeClients.map(client => client.id));
        const stalePresences = presences.filter(presence => !activeIds.has(presence.clientId));
        void Promise.all(stalePresences.map(presence => {
            return this.redisMessagingService.removeClientPresence(presence.clientId, presence.address)
                .catch(() => undefined);
        }));

        return presences.filter(presence => activeIds.has(presence.clientId));
    }

    public async refreshReport() {
        try {
            await this.userAgentReport.query(`REFRESH MATERIALIZED VIEW user_agent_report_view`);
            return await this.refreshLiveReport();
        } catch (e) {

            console.log(e)
        }

    }
}
