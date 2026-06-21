import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientEntity } from '../../client/client.entity';
import { UserAgentReportView } from './user-agent-report.view';
import { RedisMessagingService } from '../../../services/redis-messaging.service';

const DEFAULT_CLIENT_REPORT_ACTIVE_WINDOW_MS = 30 * 60 * 1000;

@Injectable()
export class UserAgentReportService {
    private readonly liveReportCacheKey = 'presence:user-agent-report';
    private readonly activeWindowMs = this.readPositiveInt('CLIENT_REPORT_ACTIVE_WINDOW_MS', DEFAULT_CLIENT_REPORT_ACTIVE_WINDOW_MS);
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
        const activeSince = new Date(Date.now() - this.activeWindowMs);
        const rows = await this.clientRepository
            .createQueryBuilder('client')
            .select('COALESCE(NULLIF(client.userAgent, \'\'), \'Other\')', 'userAgent')
            .addSelect('COUNT(*)', 'count')
            .addSelect('MAX(client.bestDifficulty)', 'bestDifficulty')
            .addSelect('COALESCE(SUM(client.hashRate), 0)', 'totalHashRate')
            .where('client.deletedAt IS NULL')
            .andWhere('client.updatedAt > :activeSince', { activeSince })
            .groupBy('COALESCE(NULLIF(client.userAgent, \'\'), \'Other\')')
            .orderBy('"totalHashRate"', 'DESC')
            .getRawMany<UserAgentReportView>();

        if (rows.length === 0) {
            return await this.userAgentReport.find();
        }

        await this.redisMessagingService
            .setJsonCache(this.liveReportCacheKey, rows, 60 * 1000)
            .catch(error => {
                console.error(`Live user-agent report cache write failed: ${error.message}`);
            });

        return rows;
    }

    public async refreshReport() {
        try {
            await this.userAgentReport.query(`REFRESH MATERIALIZED VIEW user_agent_report_view`);
            return await this.refreshLiveReport();
        } catch (e) {

            console.log(e)
        }

    }

    private readPositiveInt(name: string, defaultValue: number): number {
        const value = Number(process.env[name]);
        if (Number.isInteger(value) && value > 0) {
            return value;
        }
        return defaultValue;
    }
}
