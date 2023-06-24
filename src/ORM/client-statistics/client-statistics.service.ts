import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientStatisticsEntity } from './client-statistics.entity';


@Injectable()
export class ClientStatisticsService {

    constructor(
        @InjectRepository(ClientStatisticsEntity)
        private clientStatisticsRepository: Repository<ClientStatisticsEntity>
    ) {

    }

    public async save(clientStatistic: Partial<ClientStatisticsEntity>) {
        return await this.clientStatisticsRepository.save(clientStatistic);
    }

    public async getHashRate(sessionId: string) {

        const query = `
            SELECT
            (JULIANDAY(MAX(entry.time)) - JULIANDAY(MIN(entry.time))) * 24 * 60 * 60 AS timeDiff,
            SUM(entry.difficulty) AS difficultySum
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.sessionId = ? AND entry.time > datetime("now", "-1 hour")
        `;

        const result = await this.clientStatisticsRepository.query(query, [sessionId]);

        const timeDiff = result[0].timeDiff;
        const difficultySum = result[0].difficultySum;

        return (difficultySum * 4294967296) / (timeDiff * 1000000000);

    }

    public async getChartData(sessionId: string) {
        const query = `
            WITH result_set AS (
                SELECT
                    MAX(time) AS label,
                    (SUM(difficulty) * 4294967296) /
                    ((JULIANDAY(MAX(time)) - JULIANDAY(MIN(time))) * 24 * 60 * 60 * 1000000000) AS data
                FROM
                    client_statistics_entity AS entry
                WHERE
                    entry.sessionId = ? AND entry.time > datetime("now", "-1 day")
                GROUP BY
                    strftime('%Y-%m-%d %H', time, 'localtime') || (strftime('%M', time, 'localtime') / 5)
            )
            SELECT *
            FROM result_set
            WHERE label <> (SELECT MAX(Label) FROM result_set);
        `;

        const result = await this.clientStatisticsRepository.query(query, [sessionId]);

        return result;
    }

    public async deleteAll() {
        return await this.clientStatisticsRepository.delete({})
    }
}