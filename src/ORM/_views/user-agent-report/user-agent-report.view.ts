import { DataSource, ViewColumn, ViewEntity } from 'typeorm';

import { ClientEntity } from '../../client/client.entity';

@ViewEntity({
    materialized: true,
    expression: (dataSource: DataSource) =>
        dataSource
            .createQueryBuilder()
            .select('client.userAgent as "userAgent"')
            .addSelect('COUNT(client.userAgent)', 'count')
            .addSelect('MAX(client.bestDifficulty)', 'bestDifficulty')
            .addSelect('SUM(client.hashRate)', 'totalHashRate')
            .from(ClientEntity, 'client')
            .groupBy('client.userAgent')
            .orderBy('"totalHashRate"', 'DESC')
})
export class UserAgentReportView {
    @ViewColumn()
    userAgent: string;
    @ViewColumn()
    count: string;
    @ViewColumn()
    bestDifficulty: number;
    @ViewColumn()
    totalHashRate: string;
}