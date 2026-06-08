import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

const HASHES_PER_DIFFICULTY = 4294967296;
const CHART_BUCKET_SECONDS = 600;
const CHART_WINDOW = '24 hours';
const SITE_CHART_WINDOW = '7 days';

@Injectable()
export class ClientStatisticsService {

    constructor(
        @InjectDataSource()
        private dataSource: DataSource,
    ) {

    }

    public async getChartDataForSite(limit: number = 144 * 7) {
        return this.getAcceptedShareChartData('', [], limit, SITE_CHART_WINDOW);
    }

    public async getChartDataForAddress(address: string) {
        return this.getAcceptedShareChartData(
            'AND "address" = $1',
            [address],
            144,
            CHART_WINDOW,
        );
    }

    public async getHashRateForGroup(address: string, clientName: string) {
        const result = await this.dataSource.query(`
            SELECT
                COALESCE((SUM("creditedDifficulty") * ${HASHES_PER_DIFFICULTY}) / ${CHART_BUCKET_SECONDS}, 0) AS "hashRate"
            FROM "accepted_share_entity"
            WHERE "address" = $1
                AND "clientName" = $2
                AND "acceptedAt" > NOW() - INTERVAL '1 hour'
        `, [address, clientName]);

        return parseFloat(result[0]?.hashRate ?? '0');
    }

    public async getChartDataForGroup(address: string, clientName: string) {
        return this.getAcceptedShareChartData(
            'AND "address" = $1 AND "clientName" = $2',
            [address, clientName],
            144,
            CHART_WINDOW,
        );
    }

    public async getChartDataForSession(clientId: string) {
        return this.getAcceptedShareChartData(
            'AND "clientId" = $1',
            [clientId],
            144,
            CHART_WINDOW,
        );
    }

    private async getAcceptedShareChartData(filterSql: string, params: unknown[], limit: number, windowSql: string) {
        const query = `
            WITH bounds AS (
                SELECT
                    NOW() - INTERVAL '${windowSql}' AS since,
                    time_bucket(INTERVAL '10 minutes', NOW()) AS current_bucket
            )
            SELECT
                "label",
                "data",
                "shares",
                "acceptedCount"
            FROM (
                SELECT
                    "bucket" AS "label",
                    ROUND((SUM("shares") * ${HASHES_PER_DIFFICULTY}) / ${CHART_BUCKET_SECONDS}) AS "data",
                    SUM("shares") AS "shares",
                    SUM("acceptedCount") AS "acceptedCount"
                FROM "accepted_share_10m", bounds
                WHERE "bucket" > bounds.since
                    AND "bucket" < bounds.current_bucket
                    ${filterSql}
                GROUP BY "bucket"
                ORDER BY "bucket" DESC
                LIMIT ${limit}
            ) AS limited_rows
            ORDER BY "label"
        `;

        const result = await this.dataSource.query(query, params);

        return result.map(res => {
            return {
                label: new Date(res.label).toISOString(),
                data: res.data,
                shares: Number(res.shares ?? 0),
                acceptedCount: Number(res.acceptedCount ?? 0),
            };
        });
    }
}
