import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientEntity } from '../../client/client.entity';
import { UserAgentReportView } from './user-agent-report.view';
import { RedisMessagingService } from '../../../services/redis-messaging.service';

@Injectable()
export class UserAgentReportService {

    constructor(
        @InjectRepository(UserAgentReportView)
        private userAgentReport: Repository<UserAgentReportView>,
        @InjectRepository(ClientEntity)
        private clientRepository: Repository<ClientEntity>,
        private redisMessagingService: RedisMessagingService,
    ) {

    }

    public async getReport() {
        const presences = await this.redisMessagingService.getAllClientPresence();
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

        return [...rows.values()]
            .sort((left, right) => right.totalHashRate - left.totalHashRate)
            .map(row => ({
                userAgent: row.userAgent,
                count: row.count.toString(),
                bestDifficulty: row.bestDifficulty,
                totalHashRate: row.totalHashRate.toString(),
            }));
    }

    public async refreshReport() {
        try {
            return await this.userAgentReport.query(`REFRESH MATERIALIZED VIEW user_agent_report_view`);
        } catch (e) {

            console.log(e)
        }

    }
}
