import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { AcceptedShareEntity } from '../src/ORM/accepted-share/accepted-share.entity';
import { UserAgentReportService } from '../src/ORM/_views/user-agent-report/user-agent-report.service';
import { UserAgentReportView } from '../src/ORM/_views/user-agent-report/user-agent-report.view';
import { ClientStatisticsService } from '../src/ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../src/ORM/client/client.entity';
import { ShareAccountingService } from '../src/ORM/share-accounting/share-accounting.service';
import { RedisMessagingService } from '../src/services/redis-messaging.service';

describe('TimescaleDB and Redis integration', () => {
  let dataSource: DataSource;
  let redisMessagingService: RedisMessagingService;

  beforeAll(async () => {
    process.env.DB_HOST ??= '127.0.0.1';
    process.env.DB_PORT ??= '15432';
    process.env.DB_USERNAME ??= 'public_pool';
    process.env.DB_PASSWORD ??= 'public_pool';
    process.env.DB_DATABASE ??= 'public_pool_test';
    process.env.REDIS_URL ??= 'redis://127.0.0.1:16379';

    const imported = await import('../src/data-source');
    dataSource = imported.AppDataSource;
    if (!dataSource.isInitialized) {
      await dataSource.initialize();
    }
    await dataSource.runMigrations();

    redisMessagingService = new RedisMessagingService({
      get: jest.fn((key: string) => key === 'REDIS_URL' ? process.env.REDIS_URL : null),
    } as unknown as ConfigService);
    await redisMessagingService.connect();
  });

  afterAll(async () => {
    await redisMessagingService?.onModuleDestroy();
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    await dataSource.query(`DELETE FROM accepted_share_entity`);
    await dataSource.query(`DELETE FROM client_entity`);
    await dataSource.query(`REFRESH MATERIALIZED VIEW user_agent_report_view`);
  });

  it('should create Timescale extension, hypertable, continuous aggregates, and operational policies', async () => {
    const extensions = await dataSource.query(`SELECT extname FROM pg_extension WHERE extname = 'timescaledb'`);
    expect(extensions).toHaveLength(1);

    const hypertables = await dataSource.query(`
      SELECT hypertable_name, compression_enabled
      FROM timescaledb_information.hypertables
      WHERE hypertable_name = 'accepted_share_entity'
    `);
    expect(hypertables).toHaveLength(1);
    expect(hypertables[0].compression_enabled).toBe(true);

    const aggregates = await dataSource.query(`
      SELECT view_name
      FROM timescaledb_information.continuous_aggregates
      WHERE view_name IN ('accepted_share_10m', 'accepted_share_1h', 'accepted_share_1d')
      ORDER BY view_name
    `);
    expect(aggregates.map(row => row.view_name)).toEqual([
      'accepted_share_10m',
      'accepted_share_1d',
      'accepted_share_1h',
    ]);

    const legacyTables = await dataSource.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('client_statistics_entity', 'home_graph_entity')
    `);
    expect(legacyTables).toHaveLength(0);

    const policies = await dataSource.query(`
      SELECT proc_name, schedule_interval::text AS schedule_interval
      FROM timescaledb_information.jobs
      WHERE hypertable_name = 'accepted_share_entity'
         OR application_name LIKE 'Refresh Continuous Aggregate Policy%'
      ORDER BY proc_name, schedule_interval
    `);
    expect(policies).toEqual(expect.arrayContaining([
      expect.objectContaining({ proc_name: 'policy_compression' }),
      expect.objectContaining({ proc_name: 'policy_retention' }),
      expect.objectContaining({ proc_name: 'policy_refresh_continuous_aggregate' }),
    ]));
  });

  it('should persist accepted shares and refresh the 10 minute aggregate', async () => {
    const client = await dataSource.getRepository(ClientEntity).save({
      address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
      clientName: 'worker',
      sessionId: '57a6f098',
      userAgent: 'integration-test',
      startTime: new Date(),
      bestDifficulty: 0,
      hashRate: 0,
    });
    const service = new ShareAccountingService(dataSource.getRepository(AcceptedShareEntity));
    const acceptedAt = new Date('2026-06-07T12:10:00Z');

    await service.recordAcceptedShare({
      protocol: 'sv1',
      acceptedAt,
      address: client.address,
      clientName: client.clientName,
      sessionId: client.sessionId,
      clientId: client.id,
      jobId: '1',
      jobTemplateId: '1',
      blockHeight: 900000,
      creditedDifficulty: 64,
      submissionDifficulty: 128,
      networkDifficulty: 100000,
      nonce: 'ed460d91',
      ntime: '64b3f3ec',
      version: '20000000',
      extraNonce2: 'c708000000000000',
      isBlockCandidate: false,
      blockSubmissionResult: null,
    });

    const rows = await dataSource.query(`SELECT COUNT(*)::int AS count FROM accepted_share_entity`);
    expect(rows[0].count).toBeGreaterThanOrEqual(1);

    await dataSource.query(`CALL refresh_continuous_aggregate('accepted_share_10m', NULL, NULL)`);
    const aggregateRows = await dataSource.query(`
      SELECT "shares"::float AS shares, "acceptedCount"::int AS "acceptedCount"
      FROM accepted_share_10m
      WHERE "address" = $1 AND "clientName" = $2
    `, [client.address, client.clientName]);

    expect(aggregateRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ shares: 64, acceptedCount: 1 }),
    ]));
  });

  it('should exclude soft-deleted clients from the user-agent report', async () => {
    const userAgent = `integration-reconnect-${Date.now()}`;
    const repository = dataSource.getRepository(ClientEntity);

    const activeClient = await repository.save({
      address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
      clientName: 'active-worker',
      sessionId: 'a1b2c3d4',
      userAgent,
      startTime: new Date(),
      bestDifficulty: 10,
      hashRate: 100,
    });
    const staleClient = await repository.save({
      address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
      clientName: 'stale-worker',
      sessionId: 'd4c3b2a1',
      userAgent,
      startTime: new Date(),
      bestDifficulty: 20,
      hashRate: 200,
    });
    await repository.softDelete(staleClient.id);

    await dataSource.query(`REFRESH MATERIALIZED VIEW user_agent_report_view`);
    const rows = await dataSource.query(`
      SELECT "count"::int AS "count", "bestDifficulty"::float AS "bestDifficulty", "totalHashRate"::float AS "totalHashRate"
      FROM user_agent_report_view
      WHERE "userAgent" = $1
    `, [userAgent]);

    expect(rows).toEqual([{
      count: 1,
      bestDifficulty: Number(activeClient.bestDifficulty),
      totalHashRate: Number(activeClient.hashRate),
    }]);
  });

  it('should serve live active user-agent reports without waiting for materialized refresh', async () => {
    const userAgent = `integration-live-reconnect-${Date.now()}`;
    const repository = dataSource.getRepository(ClientEntity);
    const reportService = new UserAgentReportService(
      dataSource.getRepository(UserAgentReportView),
      repository,
      redisMessagingService,
      new ShareAccountingService(dataSource.getRepository(AcceptedShareEntity)),
    );

    const activeClient = await repository.save({
      address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
      clientName: 'active-live-worker',
      sessionId: '91b2c3d4',
      userAgent,
      startTime: new Date(),
      bestDifficulty: 11,
      hashRate: 0,
    });
    await repository.save({
      address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
      clientName: 'stale-live-worker',
      sessionId: '92b2c3d4',
      userAgent,
      startTime: new Date(),
      bestDifficulty: 22,
      hashRate: 200,
    });

    await redisMessagingService.setClientPresence({
      clientId: activeClient.id,
      address: activeClient.address,
      clientName: activeClient.clientName,
      sessionId: activeClient.sessionId,
      userAgent,
      startTime: activeClient.startTime.toISOString(),
      lastSeen: new Date().toISOString(),
      bestDifficulty: Number(activeClient.bestDifficulty),
      hashRate: 0,
    });

    const rows = await reportService.getReport();
    expect(rows).toEqual(expect.arrayContaining([{
      userAgent,
      count: '1',
      bestDifficulty: Number(activeClient.bestDifficulty),
      totalHashRate: '0',
    }]));
  });

  it('should serve realtime chart and hashrate data from accepted shares', async () => {
    const client = await dataSource.getRepository(ClientEntity).save({
      address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
      clientName: 'worker',
      sessionId: '8f3c5d2a',
      userAgent: 'integration-test',
      startTime: new Date(),
      bestDifficulty: 0,
      hashRate: 0,
    });
    const accountingService = new ShareAccountingService(dataSource.getRepository(AcceptedShareEntity));
    const statisticsService = new ClientStatisticsService(dataSource);
    const acceptedAt = new Date();

    for (const [index, difficulty] of [64, 32].entries()) {
      await accountingService.recordAcceptedShare({
        protocol: 'sv1',
        acceptedAt: new Date(acceptedAt.getTime() + index),
        address: client.address,
        clientName: client.clientName,
        sessionId: client.sessionId,
        clientId: client.id,
        jobId: `realtime-${index}`,
        jobTemplateId: 'realtime-template',
        blockHeight: 900001,
        creditedDifficulty: difficulty,
        submissionDifficulty: difficulty * 2,
        networkDifficulty: 100000,
        nonce: `nonce-${index}`,
        ntime: '64b3f3ec',
        version: '20000000',
        extraNonce2: 'c708000000000000',
        isBlockCandidate: false,
        blockSubmissionResult: null,
      });
    }

    const expectedHashRate = (96 * 4294967296) / 600;
    const expectedChartData = Math.round(expectedHashRate).toString();
    expect(await statisticsService.getHashRateForGroup(client.address, client.clientName))
      .toBeCloseTo(expectedHashRate);

    const addressChart = await statisticsService.getChartDataForAddress(client.address);
    const groupChart = await statisticsService.getChartDataForGroup(client.address, client.clientName);
    const sessionChart = await statisticsService.getChartDataForSession(client.id);
    const siteChart = await statisticsService.getChartDataForSite();

    for (const chart of [addressChart, groupChart, sessionChart, siteChart]) {
      expect(chart).toEqual(expect.arrayContaining([
        expect.objectContaining({ data: expectedChartData }),
      ]));
    }
  });

  it('should replay mining info and block templates through Redis', async () => {
    await redisMessagingService.setLatestMiningInfo({ blocks: 900001 } as any);
    await redisMessagingService.setBlockTemplate(900001, { height: 900001, transactions: [] } as any);

    expect(await redisMessagingService.getLatestMiningInfo()).toEqual({ blocks: 900001 });
    expect(await redisMessagingService.getBlockTemplate(900001)).toEqual({ height: 900001, transactions: [] });

    const received: any[] = [];
    await redisMessagingService.subscribeMiningInfoUpdates(async miningInfo => {
      received.push(miningInfo);
    });
    await redisMessagingService.publishMiningInfoUpdate({ blocks: 900002 } as any);
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(received).toEqual([{ blocks: 900002 }]);
  });
});
