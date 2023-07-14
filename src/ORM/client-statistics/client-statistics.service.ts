import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientStatisticsEntity } from './client-statistics.entity';


@Injectable()
export class ClientStatisticsService {

    constructor(


        @InjectRepository(ClientStatisticsEntity)
        private clientStatisticsRepository: Repository<ClientStatisticsEntity>,
    ) {

    }

    public async save(clientStatistic: Partial<ClientStatisticsEntity>) {
        return await this.clientStatisticsRepository.save(clientStatistic);
    }

    public async deleteOldStatistics() {
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        return await this.clientStatisticsRepository
            .createQueryBuilder()
            .delete()
            .from(ClientStatisticsEntity)
            .where('time < :time', { time: oneDayAgo })
            .execute();
    }

    public async getChartDataForSite() {


        const query = `
        WITH result_set AS (
            SELECT
                MAX(time) || 'GMT' AS label,
                (SUM(difficulty) * 4294967296) /
                ((JULIANDAY(MAX(time)) - JULIANDAY(MIN(time))) * 24 * 60 * 60) AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.time > datetime("now", "-1 day")
            GROUP BY
                strftime('%Y-%m-%d %H', time, 'localtime') || (strftime('%M', time, 'localtime') / 10)
            ORDER BY
            time
        )
        SELECT  *
        FROM result_set
        WHERE label <> (SELECT MAX(label) FROM result_set);
    `;

        const result = await this.clientStatisticsRepository.query(query);



        return result.map(res => {
            res.label = new Date(res.label).toISOString();
            return res;
        });

    }


    public async getHashRateForAddress(address: string) {

        const query = `
            SELECT
            (JULIANDAY(MAX(entry.time)) - JULIANDAY(MIN(entry.time))) * 24 * 60 * 60 AS timeDiff,
            SUM(entry.difficulty) AS difficultySum
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = ? AND entry.time > datetime("now", "-1 hour")
        `;

        const result = await this.clientStatisticsRepository.query(query, [address]);

        const timeDiff = result[0].timeDiff;
        const difficultySum = result[0].difficultySum;

        return (difficultySum * 4294967296) / (timeDiff);

    }

    public async getChartDataForAddress(address: string) {
        const query = `
            WITH result_set AS (
                SELECT
                    MAX(time) || 'GMT' AS label,
                    (SUM(difficulty) * 4294967296) /
                    ((JULIANDAY(MAX(time)) - JULIANDAY(MIN(time))) * 24 * 60 * 60) AS data
                FROM
                    client_statistics_entity AS entry
                WHERE
                entry.address = ? AND entry.time > datetime("now", "-1 day")
                GROUP BY
                    strftime('%Y-%m-%d %H', time, 'localtime') || (strftime('%M', time, 'localtime') / 10)
                ORDER BY
                time
            )
            SELECT  *
            FROM result_set
            WHERE label <> (SELECT MAX(label) FROM result_set);
        `;

        const result = await this.clientStatisticsRepository.query(query, [address]);

        return result.map(res => {
            res.label = new Date(res.label).toISOString();
            return res;
        });

        return result;
    }


    public async getHashRateForGroup(address: string, clientName: string) {

        const query = `
            SELECT
            (JULIANDAY(MAX(entry.time)) - JULIANDAY(MIN(entry.time))) * 24 * 60 * 60 AS timeDiff,
            SUM(entry.difficulty) AS difficultySum
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = ? AND entry.clientName = ? AND entry.time > datetime("now", "-1 hour")
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName]);

        const timeDiff = result[0].timeDiff;
        const difficultySum = result[0].difficultySum;

        return (difficultySum * 4294967296) / (timeDiff);

    }

    public async getChartDataForGroup(address: string, clientName: string) {
        const query = `
            WITH result_set AS (
                SELECT
                    MAX(time) || 'GMT' AS label,
                    (SUM(difficulty) * 4294967296) /
                    ((JULIANDAY(MAX(time)) - JULIANDAY(MIN(time))) * 24 * 60 * 60) AS data
                FROM
                    client_statistics_entity AS entry
                WHERE
                entry.address = ? AND entry.clientName = ? AND entry.time > datetime("now", "-1 day")
                GROUP BY
                    strftime('%Y-%m-%d %H', time, 'localtime') || (strftime('%M', time, 'localtime') / 10)
                ORDER BY
                time
            )
            SELECT *
            FROM result_set
            WHERE label <> (SELECT MAX(label) FROM result_set);
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName]);

        return result.map(res => {
            res.label = new Date(res.label).toISOString();
            return res;
        });

        return result;
    }


    public async getHashRateForSession(address: string, clientName: string, sessionId: string) {

        const query = `
            SELECT
            (JULIANDAY(MAX(entry.time)) - JULIANDAY(MIN(entry.time))) * 24 * 60 * 60 AS timeDiff,
            SUM(entry.difficulty) AS difficultySum
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = ? AND entry.clientName = ? AND entry.sessionId = ? AND entry.time > datetime("now", "-1 hour")
            
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName, sessionId]);

        const timeDiff = result[0].timeDiff;
        const difficultySum = result[0].difficultySum;

        return (difficultySum * 4294967296) / (timeDiff);

    }

    public async getChartDataForSession(address: string, clientName: string, sessionId: string) {
        const query = `
            WITH result_set AS (
                SELECT
                    MAX(time) || 'GMT' AS label,
                    (SUM(difficulty) * 4294967296) /
                    ((JULIANDAY(MAX(time)) - JULIANDAY(MIN(time))) * 24 * 60 * 60) AS data
                FROM
                    client_statistics_entity AS entry
                WHERE
                entry.address = ? AND entry.clientName = ? AND entry.sessionId = ? AND entry.time > datetime("now", "-1 day")
                GROUP BY
                    strftime('%Y-%m-%d %H', time, 'localtime') || (strftime('%M', time, 'localtime') / 10)
                ORDER BY
                    time
            )
            SELECT *
            FROM result_set
            WHERE label <> (SELECT MAX(label) FROM result_set);
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName, sessionId]);

        return result.map(res => {
            res.label = new Date(res.label).toISOString();
            return res;
        });

        return result;
    }

    public async deleteAll() {
        return await this.clientStatisticsRepository.delete({})
    }
}