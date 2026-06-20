import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { normalizePayoutMode, PayoutMode } from '../../types/payout-mode';

const HASHES_PER_DIFFICULTY = 4294967296;
const CHART_BUCKET_SECONDS = 600;
const CHART_WINDOW = '24 hours';
const SITE_CHART_WINDOW = '7 days';

interface AcceptedShareChartFilter {
    address?: string;
    clientName?: string;
    clientId?: string;
    payoutMode?: PayoutMode;
}

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

    public async getChartDataForSiteByPayoutMode(payoutMode?: PayoutMode, limit: number = 144 * 7) {
        return this.getAcceptedShareChartDataByPayoutMode({ payoutMode }, limit, SITE_CHART_WINDOW);
    }

    public async getChartDataForAddress(address: string) {
        return this.getAcceptedShareChartData(
            'AND "address" = $1',
            [address],
            144,
            CHART_WINDOW,
        );
    }

    public async getChartDataForAddressByPayoutMode(address: string, payoutMode?: PayoutMode) {
        return this.getAcceptedShareChartDataByPayoutMode({ address, payoutMode }, 144, CHART_WINDOW);
    }

    public async getHashRateForGroup(address: string, clientName: string) {
        const result = await this.dataSource.query(`
            WITH bounds AS (
                SELECT time_bucket(INTERVAL '10 minutes', NOW()) AS current_bucket
            ),
            completed AS (
                SELECT COALESCE(SUM("shares"), 0) AS "creditedDifficulty"
                FROM "accepted_share_10m", bounds
                WHERE "address" = $1
                    AND "clientName" = $2
                    AND "bucket" > bounds.current_bucket - INTERVAL '1 hour'
                    AND "bucket" < bounds.current_bucket
            ),
            live AS (
                SELECT COALESCE(SUM("creditedDifficulty"), 0) AS "creditedDifficulty"
                FROM "accepted_share_entity", bounds
                WHERE "address" = $1
                    AND "clientName" = $2
                    AND "acceptedAt" >= bounds.current_bucket
            )
            SELECT
                COALESCE(((completed."creditedDifficulty" + live."creditedDifficulty") * ${HASHES_PER_DIFFICULTY}) / ${CHART_BUCKET_SECONDS}, 0) AS "hashRate"
            FROM completed, live
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

    public async getChartDataForGroupByPayoutMode(address: string, clientName: string, payoutMode?: PayoutMode) {
        return this.getAcceptedShareChartDataByPayoutMode({ address, clientName, payoutMode }, 144, CHART_WINDOW);
    }

    public async getChartDataForSession(clientId: string) {
        return this.getAcceptedShareChartData(
            'AND "clientId" = $1',
            [clientId],
            144,
            CHART_WINDOW,
        );
    }

    public async getChartDataForSessionByPayoutMode(clientId: string, payoutMode?: PayoutMode) {
        return this.getAcceptedShareChartDataByPayoutMode({ clientId, payoutMode }, 144, CHART_WINDOW);
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

    private async getAcceptedShareChartDataByPayoutMode(
        filter: AcceptedShareChartFilter,
        limit: number,
        windowSql: string,
    ) {
        const { whereSql, params } = this.buildModeChartWhere(filter);
        const query = `
            WITH bounds AS (
                SELECT
                    NOW() - INTERVAL '${windowSql}' AS since,
                    time_bucket(INTERVAL '10 minutes', NOW()) AS current_bucket
            )
            SELECT
                "label",
                "payoutMode",
                "data",
                "shares",
                "acceptedCount"
            FROM (
                SELECT
                    "bucket" AS "label",
                    "payoutMode",
                    ROUND((SUM("shares") * ${HASHES_PER_DIFFICULTY}) / ${CHART_BUCKET_SECONDS}) AS "data",
                    SUM("shares") AS "shares",
                    SUM("acceptedCount") AS "acceptedCount"
                FROM "accepted_share_10m", bounds
                WHERE "bucket" > bounds.since
                    AND "bucket" < bounds.current_bucket
                    ${whereSql}
                GROUP BY "bucket", "payoutMode"
                ORDER BY "bucket" DESC
                LIMIT ${limit * 2}
            ) AS limited_rows
            ORDER BY "label", "payoutMode"
        `;

        const result = await this.dataSource.query(query, params);

        return result.map(res => {
            return {
                label: new Date(res.label).toISOString(),
                payoutMode: res.payoutMode,
                data: res.data,
                shares: Number(res.shares ?? 0),
                acceptedCount: Number(res.acceptedCount ?? 0),
            };
        });
    }

    private buildModeChartWhere(filter: AcceptedShareChartFilter): { whereSql: string; params: string[] } {
        const where: string[] = [];
        const params: string[] = [];

        if (filter.address != null) {
            params.push(filter.address);
            where.push(`"address" = $${params.length}`);
        }
        if (filter.clientName != null) {
            params.push(filter.clientName);
            where.push(`"clientName" = $${params.length}`);
        }
        if (filter.clientId != null) {
            params.push(filter.clientId);
            where.push(`"clientId" = $${params.length}`);
        }
        if (filter.payoutMode != null) {
            params.push(normalizePayoutMode(filter.payoutMode));
            where.push(`"payoutMode" = $${params.length}`);
        }

        return {
            whereSql: where.length > 0 ? `AND ${where.join(' AND ')}` : '',
            params,
        };
    }
}
