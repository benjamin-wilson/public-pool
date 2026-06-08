import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientEntity } from '../../client/client.entity';
import { UserAgentReportView } from './user-agent-report.view';
import { RedisMessagingService } from '../../../services/redis-messaging.service';
import { logTiming, timeAsync, timingStart } from '../../../utils/timing.utils';

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
        const start = timingStart();
        const cachedReport = await timeAsync('user agent report shared cache read', () => this.redisMessagingService
            .getJsonCache<UserAgentReportView[]>(this.liveReportCacheKey)
            .catch(error => {
                console.error(`Live user-agent report cache read failed: ${error.message}`);
                return null;
            }));
        if (cachedReport != null) {
            logTiming('user agent report getReport', start, { cache: 'hit', rows: cachedReport.length });
            return cachedReport;
        }

        if (process.env.API_ONLY == 'true') {
            const rows = await timeAsync('user agent report materialized view read', () => this.userAgentReport.find());
            logTiming('user agent report getReport', start, { cache: 'miss', source: 'materialized-view', rows: rows.length });
            return rows;
        }

        const rows = await this.refreshLiveReport();
        logTiming('user agent report getReport', start, { cache: 'miss', source: 'live-presence', rows: rows.length });
        return rows;
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
        const start = timingStart();
        const presences = await timeAsync('user agent report all presence load', () => this.redisMessagingService.getAllClientPresence());
        const rows = new Map<string, {
            userAgent: string;
            count: number;
            bestDifficulty: number;
            totalHashRate: number;
        }>();

        presences.forEach(presence => {
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

        logTiming('user agent report buildLiveReport', start, { presences: presences.length, rows: report.length });
        return report;
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
