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

    public async getHashRate(clientId: string) {

        const query = `
            SELECT
            (JULIANDAY(MAX(entry.time)) - JULIANDAY(MIN(entry.time))) * 24 * 60 * 60 AS timeDiff,
            SUM(entry.difficulty) AS difficultySum
        FROM
            client_statistics_entity AS entry
        WHERE
            entry.clientId = ?
        `;

        const result = await this.clientStatisticsRepository.query(query, [clientId]);

        const timeDiff = result[0].timeDiff;
        const difficultySum = result[0].difficultySum;

        return (difficultySum * 4294967296) / (timeDiff * 1000000000);

    }
}