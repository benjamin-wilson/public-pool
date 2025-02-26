import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { ClientStatisticsEntity } from './client-statistics.entity';


@Injectable()
export class ClientStatisticsService {

    private bulkAsyncUpdates: Partial<ClientStatisticsEntity>[] = [];

    constructor(

        @InjectDataSource()
        private dataSource: DataSource,
        @InjectRepository(ClientStatisticsEntity)
        private clientStatisticsRepository: Repository<ClientStatisticsEntity>,
    ) {

    }

    // public async update(clientStatistic: Partial<ClientStatisticsEntity>) {

    //     await this.clientStatisticsRepository.update({ clientId: clientStatistic.clientId, time: clientStatistic.time },
    //     {
    //         shares: clientStatistic.shares,
    //         acceptedCount: clientStatistic.acceptedCount,
    //         updatedAt: new Date()
    //     });
    // }

    public updateBulkAsync(clientStatistic: Partial<ClientStatisticsEntity>, lastSeenIndex: number) {

        if(this.bulkAsyncUpdates.length > lastSeenIndex && this.bulkAsyncUpdates[lastSeenIndex].clientId == clientStatistic.clientId  && this.bulkAsyncUpdates[lastSeenIndex].time == clientStatistic.time){
            this.bulkAsyncUpdates[lastSeenIndex].shares = clientStatistic.shares;
            this.bulkAsyncUpdates[lastSeenIndex].acceptedCount = clientStatistic.acceptedCount;
            return lastSeenIndex;
        }
        
        return this.bulkAsyncUpdates.push(clientStatistic) - 1;
    }

    public async doBulkAsyncUpdate(){
        if(this.bulkAsyncUpdates.length < 1){
            console.log('No client stats to update.')
            return;
        }
        // Step 1: Prepare data for bulk update
        const values = this.bulkAsyncUpdates.map(stat => 
            `('${stat.clientId}', ${stat.time}, ${stat.shares ?? 0}, ${stat.acceptedCount ?? 0}, NOW())`
        ).join(',');
    
        const query = `
            DO $$
            BEGIN
                CREATE TEMP TABLE temp_stats (
                    "clientId" UUID,
                    time BIGINT,
                    shares NUMERIC,
                    "acceptedCount" INT,
                    "updatedAt" TIMESTAMP
                ) ON COMMIT DROP;
    
                INSERT INTO temp_stats ("clientId", time, shares, "acceptedCount", "updatedAt")
                VALUES ${values};
    
                UPDATE "client_statistics_entity" cse
                SET shares = ts.shares,
                    "acceptedCount" = ts."acceptedCount",
                    "updatedAt" = ts."updatedAt"
                FROM temp_stats ts
                WHERE cse."clientId" = ts."clientId" AND cse.time = ts.time;
            END;
            $$;
        `;
    
        try {
            await this.clientStatisticsRepository.query(query);
            //console.log(`Bulk updated ${this.bulkAsyncUpdates.length} statistics`)
        } catch (error) {
            console.error('Bulk update failed:', error.message, query);
            throw error;
        }

        this.bulkAsyncUpdates = [];
    }

    public async insert(clientStatistic: Partial<ClientStatisticsEntity>) {
        await this.clientStatisticsRepository.insert(clientStatistic);
    }

    public async deleteOldStatistics() {
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        return await this.clientStatisticsRepository
            .createQueryBuilder()
            .delete()
            .from(ClientStatisticsEntity)
            .where('time < :time', { time: oneDayAgo.getTime() })
            .execute();
    }



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


    public async getHashRateForSession(clientId: string) {

        const query = `
            SELECT
                "createdAt",
                "updatedAt",
                shares
            FROM
                client_statistics_entity AS entry
            WHERE
                entry."clientId" = $1
            ORDER BY time DESC
            LIMIT 2;
        `;

        const result = await this.clientStatisticsRepository.query(query, [clientId]);

        if (result.length < 1) {
            return 0;
        }

        const latestStat = result[0];

        if (result.length < 2) {
            const time = new Date(latestStat.updatedAt).getTime() - new Date(latestStat.createdAt).getTime();
            // 1min
            if (time < 1000 * 60) {
                return 0;
            }
            return (parseFloat(latestStat.shares) * 4294967296) / (time / 1000);
        } else {
            const secondLatestStat = result[1];
            const time = new Date(latestStat.updatedAt).getTime() - new Date(secondLatestStat.createdAt).getTime();
            // 1min
            if (time < 1000 * 60) {
                return 0;
            }
            return ((parseFloat(latestStat.shares) + parseFloat(secondLatestStat.shares)) * 4294967296) / (time / 1000);
        }

    }

    public async getChartDataForSession(clientId: string) {
        var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

        const query = `
            SELECT
                time AS label,
                (SUM(shares) * 4294967296) / 600 AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry."clientId" = $1 AND entry.time > ${yesterday.getTime()}
            GROUP BY
                time
            ORDER BY
                time
            LIMIT 144;
        `;

        const result = await this.clientStatisticsRepository.query(query, [clientId]);

        return result.map(res => {
            res.label = new Date(parseInt(res.label)).toISOString();
            return res;
        }).slice(0, result.length - 1);

    }

    public async deleteAll() {
        return await this.clientStatisticsRepository.delete({})
    }
}