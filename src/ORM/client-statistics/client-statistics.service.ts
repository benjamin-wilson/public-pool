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

    // public async save(clientStatistic: Partial<ClientStatisticsEntity>) {
    //     const res1 = await this.clientStatisticsRepository.createQueryBuilder()
    //         .update(ClientStatisticsEntity)
    //         .set({
    //             shares: () => `"shares" + ${clientStatistic.shares}`, // Use the actual value of shares here
    //             acceptedCount: () => `"acceptedCount" + 1`
    //         })
    //         .where('address = :address AND clientName = :clientName AND sessionId = :sessionId AND time = :time', { address: clientStatistic.address, clientName: clientStatistic.clientName, sessionId: clientStatistic.sessionId, time: clientStatistic.time })
    //         .execute();

    //     if (res1.affected == 0) {
    //         await this.clientStatisticsRepository.insert(clientStatistic);
    //     }
    // }
    public async save(clientStatistic: Partial<ClientStatisticsEntity>) {
        const queryRunner = this.clientStatisticsRepository.manager.connection.createQueryRunner();

        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // Acquire a lock on the selected rows
            const selectedRows = await queryRunner.manager.getRepository(ClientStatisticsEntity)
                .createQueryBuilder()
                .setLock('pessimistic_write') // Acquire a write lock
                .where('address = :address AND "clientName" = :clientName AND "sessionId" = :sessionId AND time = :time', { address: clientStatistic.address, clientName: clientStatistic.clientName, sessionId: clientStatistic.sessionId, time: clientStatistic.time })
                .getMany();

            // Update the rows
            if (selectedRows.length > 0) {
                await queryRunner.manager.getRepository(ClientStatisticsEntity)
                    .createQueryBuilder()
                    .update(ClientStatisticsEntity)
                    .set({
                        shares: () => `"shares" + ${clientStatistic.shares}`,
                        acceptedCount: () => `"acceptedCount" + 1`
                    })
                    .where('address = :address AND "clientName" = :clientName AND "sessionId" = :sessionId AND time = :time', { address: clientStatistic.address, clientName: clientStatistic.clientName, sessionId: clientStatistic.sessionId, time: clientStatistic.time })
                    .execute();
            } else {
                // If no rows were found, insert a new record
                await queryRunner.manager.getRepository(ClientStatisticsEntity).insert(clientStatistic);
            }

            await queryRunner.commitTransaction();
        } catch (error) {
            await queryRunner.rollbackTransaction();
            throw error;
        } finally {
            await queryRunner.release();
        }
    }

    public async deleteOldStatistics() {
        const eightDays = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

        return await this.clientStatisticsRepository
            .createQueryBuilder()
            .delete()
            .from(ClientStatisticsEntity)
            .where('time < :time', { time: eightDays.getTime() })
            .execute();
    }

    public async getChartDataForSite() {

        var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

        const query = `
            SELECT
                time AS label,
                ROUND(((SUM(shares) * 4294967296) / 600)) AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.time > ${yesterday.getTime()}
            GROUP BY
                time
            ORDER BY
                time
            LIMIT 144;
        
    `;

        const result: any[] = await this.clientStatisticsRepository.query(query);


        return result.map(res => {
            res.label = new Date(parseInt(res.label)).toISOString();
            return res;
        }).slice(0, result.length - 1)

    }


    // public async getHashRateForAddress(address: string) {

    //     const oneHour = new Date(new Date().getTime() - (60 * 60 * 1000));

    //     const query = `
    //         SELECT
    //         SUM(entry.shares) AS difficultySum
    //         FROM
    //             client_statistics_entity AS entry
    //         WHERE
    //             entry.address = $1 AND entry.time > ${oneHour}
    //     `;

    //     const result = await this.clientStatisticsRepository.query(query, [address]);

    //     const difficultySum = result[0].difficultySum;

    //     return (difficultySum * 4294967296) / (600);

    // }

    public async getChartDataForAddress(address: string) {

        var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

        const query = `
                SELECT
                    time AS label,
                    (SUM(shares) * 4294967296) / 600 AS data
                FROM
                    client_statistics_entity AS entry
                WHERE
                    entry.address = $1 AND entry.time > $2
                GROUP BY
                    time
                ORDER BY
                    time
                LIMIT 144;

        `;

        const result = await this.clientStatisticsRepository.query(query, [address, yesterday.getTime()]);

        return result.map(res => {
            res.label = new Date(parseInt(res.label)).toISOString();
            return res;
        }).slice(0, result.length - 1);


    }


    public async getHashRateForGroup(address: string, clientName: string) {

        var oneHour = new Date(new Date().getTime() - (60 * 60 * 1000));

        const query = `
            SELECT
            SUM(entry.shares) AS difficultySum
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = $1 AND entry.clientName = $2 AND entry.time > ${oneHour.getTime()}
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName]);


        const difficultySum = result[0].difficultySum;

        return (difficultySum * 4294967296) / (600);

    }

    public async getChartDataForGroup(address: string, clientName: string) {
        var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

        const query = `
            SELECT
                time AS label,
                (SUM(shares) * 4294967296) / 600 AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = $1 AND entry."clientName" = $2 AND entry.time > ${yesterday.getTime()}
            GROUP BY
                time
            ORDER BY
                time
            LIMIT 144;
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName]);

        return result.map(res => {
            res.label = new Date(parseInt(res.label)).toISOString();
            return res;
        }).slice(0, result.length - 1);


    }


    public async getHashRateForSession(address: string, clientName: string, sessionId: string) {

        const query = `
            SELECT
                "createdAt",
                "updatedAt",
                shares
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = $1 AND entry."clientName" = $2 AND entry."sessionId" = $3
            ORDER BY time DESC
            LIMIT 2;
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName, sessionId]);

        if (result.length < 1) {
            return 0;
        }

        const latestStat = result[0];

        if (result.length < 2) {
            const time = new Date(latestStat.updatedAt).getTime() - new Date(latestStat.createdAt).getTime();
            if (time < 1) {
                return 0;
            }
            return (parseFloat(latestStat.shares) * 4294967296) / (time / 1000);
        } else {
            const secondLatestStat = result[1];
            const time = new Date(latestStat.updatedAt).getTime() - new Date(secondLatestStat.createdAt).getTime();
            if (time < 1) {
                return 0;
            }
            return ((parseFloat(latestStat.shares) + parseFloat(secondLatestStat.shares)) * 4294967296) / (time / 1000);
        }

    }

    public async getChartDataForSession(address: string, clientName: string, sessionId: string) {
        var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

        const query = `
            SELECT
                time AS label,
                (SUM(shares) * 4294967296) / 600 AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = $1 AND entry."clientName" = $2 AND entry."sessionId" = $3 AND entry.time > ${yesterday.getTime()}
            GROUP BY
                time
            ORDER BY
                time
            LIMIT 144;
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName, sessionId]);

        return result.map(res => {
            res.label = new Date(parseInt(res.label)).toISOString();
            return res;
        }).slice(0, result.length - 1);

    }

    public async deleteAll() {
        return await this.clientStatisticsRepository.delete({})
    }
}