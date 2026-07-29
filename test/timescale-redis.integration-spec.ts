import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { AcceptedShareEntity } from '../src/ORM/accepted-share/accepted-share.entity';
import { UserAgentReportService } from '../src/ORM/_views/user-agent-report/user-agent-report.service';
import { UserAgentReportView } from '../src/ORM/_views/user-agent-report/user-agent-report.view';
import { ClientStatisticsService } from '../src/ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../src/ORM/client/client.entity';
import { PayoutSnapshotService } from '../src/ORM/payout-snapshot/payout-snapshot.service';
import { ShareAccountingService } from '../src/ORM/share-accounting/share-accounting.service';
import { ShareHighScoreService } from '../src/ORM/share-accounting/share-high-score.service';
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
    await dataSource.query(`DELETE FROM payout_history`);
    await dataSource.query(`DELETE FROM payout_snapshot_entry`);
    await dataSource.query(`DELETE FROM payout_snapshot`);
    await dataSource.query(`DELETE FROM payout_balance`);
    await dataSource.query(`DELETE FROM share_rollup_batch_summary`);
    await dataSource.query(`DELETE FROM share_rollup_batch`);
    await dataSource.query(`DELETE FROM accepted_share_high_score`);
    await dataSource.query(`DELETE FROM accepted_share_entity`);
    await dataSource.query(`DELETE FROM blocks_entity`);
    await dataSource.query(`DELETE FROM client_entity`);
    await dataSource.query(`REFRESH MATERIALIZED VIEW user_agent_report_view`);
    await (redisMessagingService as any).publisher.del('json-cache:presence:user-agent-report');
  });

  it('should create Timescale extension, hypertable, continuous aggregates, and operational policies', async () => {
    const extensions = await dataSource.query(`SELECT extname FROM pg_extension WHERE extname = 'timescaledb'`);
    expect(extensions).toHaveLength(1);

    const hypertables = await dataSource.query(`
      SELECT hypertable_name, compression_enabled
      FROM timescaledb_information.hypertables
      WHERE hypertable_name IN ('accepted_share_entity', 'share_rollup_batch_summary')
      ORDER BY hypertable_name
    `);
    expect(hypertables).toEqual([
      expect.objectContaining({ hypertable_name: 'accepted_share_entity', compression_enabled: true }),
      expect.objectContaining({ hypertable_name: 'share_rollup_batch_summary', compression_enabled: true }),
    ]);

    const aggregates = await dataSource.query(`
      SELECT view_name
      FROM timescaledb_information.continuous_aggregates
      WHERE view_name IN ('accepted_share_10m', 'accepted_share_1h', 'accepted_share_1d', 'accepted_share_block_10m', 'accepted_share_pool_10m')
      ORDER BY view_name
    `);
    expect(aggregates.map(row => row.view_name)).toEqual([
      'accepted_share_10m',
      'accepted_share_1d',
      'accepted_share_1h',
      'accepted_share_block_10m',
      'accepted_share_pool_10m',
    ]);

    const legacyTables = await dataSource.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('client_statistics_entity', 'home_graph_entity')
    `);
    expect(legacyTables).toHaveLength(0);

    const policies = await dataSource.query(`
      SELECT proc_name, schedule_interval::text AS schedule_interval, hypertable_name
      FROM timescaledb_information.jobs
      WHERE hypertable_name = 'accepted_share_entity'
         OR hypertable_name = 'share_rollup_batch_summary'
         OR proc_name = 'prune_share_rollup_batches'
         OR application_name LIKE 'Refresh Continuous Aggregate Policy%'
      ORDER BY proc_name, schedule_interval
    `);
    expect(policies).toEqual(expect.arrayContaining([
      expect.objectContaining({ proc_name: 'policy_compression', hypertable_name: 'accepted_share_entity' }),
      expect.objectContaining({ proc_name: 'policy_compression', hypertable_name: 'share_rollup_batch_summary' }),
      expect.objectContaining({ proc_name: 'policy_retention', hypertable_name: 'accepted_share_entity' }),
      expect.objectContaining({ proc_name: 'prune_share_rollup_batches' }),
      expect.objectContaining({ proc_name: 'policy_refresh_continuous_aggregate' }),
    ]));

    const shareOrderObjects = await dataSource.query(`
      SELECT to_regclass('public.accepted_share_index_seq') AS sequence_name,
        to_regclass('public."IDX_accepted_share_mode_order"') AS index_name,
        to_regclass('public."IDX_accepted_share_accounting_lookup"') AS dropped_accounting_lookup,
        to_regclass('public."IDX_accepted_share_client_lookup"') AS dropped_client_lookup,
        to_regclass('public."IDX_accepted_share_round_best"') AS dropped_round_best
    `);
    expect(shareOrderObjects[0]).toEqual({
      sequence_name: 'accepted_share_index_seq',
      index_name: '"IDX_accepted_share_mode_order"',
      dropped_accounting_lookup: null,
      dropped_client_lookup: null,
      dropped_round_best: null,
    });

    const shareRollupObjects = await dataSource.query(`
      SELECT
        to_regclass('public.share_rollup_batch') AS batch_table,
        to_regclass('public.share_rollup_batch_summary') AS summary_table,
        to_regclass('public.accepted_share_high_score') AS high_score_table,
        to_regclass('public."IDX_share_rollup_batch_finalized_end"') AS finalized_index,
        to_regclass('public."IDX_share_rollup_summary_batch"') AS summary_batch_index,
        to_regclass('public."UQ_accepted_share_high_score_scope"') AS high_score_scope_index,
        to_regclass('public."IDX_share_rollup_summary_address_batch"') AS dropped_summary_address_index
    `);
    expect(shareRollupObjects[0]).toEqual({
      batch_table: 'share_rollup_batch',
      summary_table: 'share_rollup_batch_summary',
      high_score_table: 'accepted_share_high_score',
      finalized_index: '"IDX_share_rollup_batch_finalized_end"',
      summary_batch_index: '"IDX_share_rollup_summary_batch"',
      high_score_scope_index: '"UQ_accepted_share_high_score_scope"',
      dropped_summary_address_index: null,
    });

    const payoutObjects = await dataSource.query(`
      SELECT
        to_regclass('public.payout_snapshot') AS snapshot_table,
        to_regclass('public.payout_snapshot_entry') AS entry_table,
        to_regclass('public.payout_balance') AS balance_table,
        to_regclass('public.payout_history') AS history_table,
        to_regclass('public."IDX_payout_snapshot_latest"') AS latest_index
    `);
    expect(payoutObjects[0]).toEqual({
      snapshot_table: 'payout_snapshot',
      entry_table: 'payout_snapshot_entry',
      balance_table: 'payout_balance',
      history_table: 'payout_history',
      latest_index: '"IDX_payout_snapshot_latest"',
    });
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
      payoutMode: 'pplns',
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
    await service.recordAcceptedShare({
      protocol: 'sv1',
      payoutMode: 'pplns',
      acceptedAt: new Date(acceptedAt.getTime() + 1),
      address: client.address,
      clientName: client.clientName,
      sessionId: client.sessionId,
      clientId: client.id,
      jobId: '2',
      jobTemplateId: '1',
      blockHeight: 900000,
      creditedDifficulty: 32,
      submissionDifficulty: 64,
      networkDifficulty: 100000,
      nonce: 'ed460d92',
      ntime: '64b3f3ec',
      version: '20000000',
      extraNonce2: 'c708000000000001',
      isBlockCandidate: false,
      blockSubmissionResult: null,
    });

    const rows = await dataSource.query(`
      SELECT COUNT(*)::int AS count, MIN("shareIndex")::bigint AS first, MAX("shareIndex")::bigint AS last
      FROM accepted_share_entity
    `);
    expect(rows[0].count).toBeGreaterThanOrEqual(1);
    expect(Number(rows[0].last)).toBeGreaterThan(Number(rows[0].first));

    await dataSource.query(`CALL refresh_continuous_aggregate('accepted_share_10m', NULL, NULL)`);
    await dataSource.query(`CALL refresh_continuous_aggregate('accepted_share_block_10m', NULL, NULL)`);
    await dataSource.query(`CALL refresh_continuous_aggregate('accepted_share_pool_10m', NULL, NULL)`);
    const aggregateRows = await dataSource.query(`
      SELECT "shares"::float AS shares, "acceptedCount"::int AS "acceptedCount"
      FROM accepted_share_10m
      WHERE "address" = $1 AND "clientName" = $2
    `, [client.address, client.clientName]);

    expect(aggregateRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ shares: 96, acceptedCount: 2 }),
    ]));

    const blockAggregateRows = await dataSource.query(`
      SELECT
        "shares"::float AS shares,
        "acceptedCount"::int AS "acceptedCount",
        "networkDifficulty"::float AS "networkDifficulty"
      FROM accepted_share_block_10m
      WHERE "blockHeight" = $1
    `, [900000]);

    expect(blockAggregateRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ shares: 96, acceptedCount: 2, networkDifficulty: 100000 }),
    ]));

    const poolAggregateRows = await dataSource.query(`
      SELECT "shares"::float AS shares, "acceptedCount"::int AS "acceptedCount"
      FROM accepted_share_pool_10m
      WHERE "payoutMode" = $1
    `, ['solo']);

    expect(poolAggregateRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ shares: 96, acceptedCount: 2 }),
    ]));
  });

  it('should retain daily and all-time best share from completed rollup buckets', async () => {
    const client = await dataSource.getRepository(ClientEntity).save({
      address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
      clientName: 'high-score-worker',
      sessionId: '67a6f099',
      userAgent: 'integration-test',
      startTime: new Date(),
      bestDifficulty: 0,
      hashRate: 0,
    });
    const accountingService = new ShareAccountingService(dataSource.getRepository(AcceptedShareEntity));
    const highScoreService = new ShareHighScoreService(dataSource);
    const bucketStartMs = Math.floor((Date.now() - 20 * 60 * 1000) / (10 * 60 * 1000)) * 10 * 60 * 1000;
    const acceptedAt = new Date(bucketStartMs + 1000);

    for (const [index, submissionDifficulty] of [4096, 1024].entries()) {
      await accountingService.recordAcceptedShare({
        protocol: index === 0 ? 'sv2' : 'sv1',
        payoutMode: 'pplns',
        acceptedAt: new Date(acceptedAt.getTime() + index),
        address: client.address,
        clientName: client.clientName,
        sessionId: client.sessionId,
        clientId: client.id,
        jobId: `high-score-${index}`,
        jobTemplateId: 'high-score-template',
        blockHeight: 900100,
        creditedDifficulty: 64,
        submissionDifficulty,
        networkDifficulty: 100000,
        nonce: `high-score-nonce-${index}`,
        ntime: '64b3f3ec',
        version: '20000000',
        extraNonce2: `c70800000000000${index}`,
        isBlockCandidate: false,
        blockSubmissionResult: null,
      });
    }

    await dataSource.query(
      `CALL refresh_continuous_aggregate('accepted_share_block_10m', $1::timestamptz, $2::timestamptz)`,
      [new Date(bucketStartMs), new Date(bucketStartMs + 10 * 60 * 1000)],
    );

    await expect(highScoreService.refreshHighScores()).resolves.toEqual(expect.objectContaining({
      processed: true,
    }));

    const rows = await dataSource.query(`
      SELECT
        "scope",
        "payoutMode",
        "submissionDifficulty"::float AS "submissionDifficulty",
        "address",
        "clientName",
        "protocol"
      FROM accepted_share_high_score
      WHERE "payoutMode" IN ('all', 'pplns')
      ORDER BY "payoutMode", "scope"
    `);

    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: 'all_time',
        payoutMode: 'all',
        submissionDifficulty: 4096,
        address: client.address,
        clientName: client.clientName,
        protocol: 'sv2',
      }),
      expect.objectContaining({
        scope: 'all_time',
        payoutMode: 'pplns',
        submissionDifficulty: 4096,
        address: client.address,
        clientName: client.clientName,
        protocol: 'sv2',
      }),
      expect.objectContaining({
        scope: 'daily',
        payoutMode: 'pplns',
        submissionDifficulty: 4096,
        address: client.address,
        clientName: client.clientName,
        protocol: 'sv2',
      }),
    ]));

    const summaryService = new ShareAccountingService(dataSource.getRepository(AcceptedShareEntity));
    await expect(summaryService.refreshPoolSummary('pplns')).resolves.toEqual(expect.objectContaining({
      bestSubmissionDifficulty: 4096,
    }));
  });

  it('should finalize accepted shares into share rollup batches without mutating raw rows', async () => {
    const client = await dataSource.getRepository(ClientEntity).save({
      address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
      clientName: 'rollup-worker',
      sessionId: '47a6f098',
      userAgent: 'integration-test',
      startTime: new Date(),
      bestDifficulty: 0,
      hashRate: 0,
    });
    const service = new ShareAccountingService(dataSource.getRepository(AcceptedShareEntity));
    const acceptedAt = new Date('2026-06-07T12:20:00Z');

    await service.recordAcceptedShare({
      protocol: 'sv1',
      payoutMode: 'pplns',
      acceptedAt,
      address: client.address,
      clientName: client.clientName,
      sessionId: client.sessionId,
      clientId: client.id,
      jobId: 'rollup-1',
      jobTemplateId: 'rollup-template',
      blockHeight: 900010,
      creditedDifficulty: 64,
      submissionDifficulty: 128,
      networkDifficulty: 100000,
      nonce: 'rollup-nonce-1',
      ntime: '64b3f3ec',
      version: '20000000',
      extraNonce2: 'c708000000000001',
      isBlockCandidate: false,
      blockSubmissionResult: null,
    });
    await service.recordAcceptedShare({
      protocol: 'sv2',
      payoutMode: 'pplns',
      acceptedAt: new Date(acceptedAt.getTime() + 1),
      address: client.address,
      clientName: client.clientName,
      sessionId: client.sessionId,
      clientId: client.id,
      jobId: 'rollup-2',
      jobTemplateId: 'rollup-template',
      blockHeight: 900010,
      creditedDifficulty: 32,
      submissionDifficulty: 64,
      networkDifficulty: 100000,
      nonce: 'rollup-nonce-2',
      ntime: '64b3f3ec',
      version: '20000000',
      extraNonce2: 'c708000000000002',
      isBlockCandidate: false,
      blockSubmissionResult: null,
    });

    await expect(service.processPendingShareRollupBatch()).resolves.toEqual(expect.objectContaining({
      processed: true,
      acceptedShareCount: 2,
      creditedDifficulty: 96,
    }));
    await expect(service.processPendingShareRollupBatch()).resolves.toEqual({
      processed: false,
      reason: 'no-shares',
    });

    const batches = await dataSource.query(`
      SELECT "acceptedShareCount"::int AS "acceptedShareCount", "creditedDifficulty"::float AS "creditedDifficulty"
      FROM share_rollup_batch
    `);
    expect(batches).toEqual([{
      acceptedShareCount: 2,
      creditedDifficulty: 96,
    }]);

    const summaries = await dataSource.query(`
      SELECT
        "protocol",
        "blockHeight",
        "acceptedShareCount"::int AS "acceptedShareCount",
        "creditedDifficulty"::float AS "creditedDifficulty",
        "bestSubmissionDifficulty"::float AS "bestSubmissionDifficulty"
      FROM share_rollup_batch_summary
      WHERE "address" = $1 AND "clientName" = $2
      ORDER BY "protocol"
    `, [client.address, client.clientName]);
    expect(summaries).toEqual([
      { protocol: 'sv1', blockHeight: 900010, acceptedShareCount: 1, creditedDifficulty: 64, bestSubmissionDifficulty: 128 },
      { protocol: 'sv2', blockHeight: 900010, acceptedShareCount: 1, creditedDifficulty: 32, bestSubmissionDifficulty: 64 },
    ]);

    const rawRows = await dataSource.query(`SELECT COUNT(*)::int AS count FROM accepted_share_entity`);
    expect(rawRows[0].count).toBe(2);
  });

  it('should create payout snapshots from finalized share rollup batches', async () => {
    process.env.PAYOUT_SNAPSHOT_ENABLED = 'true';
    process.env.PAYOUT_METHOD = 'pplns';
    process.env.PAYOUT_WINDOW_FACTOR = '4';
    process.env.PAYOUT_MAX_COINBASE_OUTPUTS = '10';
    process.env.PAYOUT_MIN_OUTPUT_SATS = '0';
    process.env.PAYOUT_FEE_PERCENT = '0';
    process.env.PAYOUT_FEE_ADDRESS = '';
    process.env.PAYOUT_COINBASE_WEIGHT_BUDGET = '50000';
    const accountingService = new ShareAccountingService(dataSource.getRepository(AcceptedShareEntity));
    const payoutSnapshotService = new PayoutSnapshotService(dataSource);
    const acceptedAt = new Date('2026-06-07T12:30:00Z');
    const clients = await Promise.all([
      dataSource.getRepository(ClientEntity).save({
        address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
        clientName: 'payout-worker-a',
        sessionId: '57a6f098',
        userAgent: 'integration-test',
        startTime: new Date(),
        bestDifficulty: 0,
        hashRate: 0,
      }),
      dataSource.getRepository(ClientEntity).save({
        address: 'tb1q99n3pu025yyu0jlywpmwzalyhm36tg5u37w20d',
        clientName: 'payout-worker-b',
        sessionId: '67a6f098',
        userAgent: 'integration-test',
        startTime: new Date(),
        bestDifficulty: 0,
        hashRate: 0,
      }),
    ]);

    for (const [index, client] of clients.entries()) {
      await accountingService.recordAcceptedShare({
        protocol: 'sv1',
        payoutMode: 'pplns',
        acceptedAt: new Date(acceptedAt.getTime() + index),
        address: client.address,
        clientName: client.clientName,
        sessionId: client.sessionId,
        clientId: client.id,
        jobId: `payout-${index}`,
        jobTemplateId: 'payout-template',
        blockHeight: 900020,
        creditedDifficulty: index === 0 ? 64 : 32,
        submissionDifficulty: index === 0 ? 128 : 64,
        networkDifficulty: 100000,
        nonce: `payout-nonce-${index}`,
        ntime: '64b3f3ec',
        version: '20000000',
        extraNonce2: `c70800000000000${index}`,
        isBlockCandidate: false,
        blockSubmissionResult: null,
      });
    }

    await expect(accountingService.processPendingShareRollupBatch()).resolves.toEqual(expect.objectContaining({
      processed: true,
      acceptedShareCount: 2,
      creditedDifficulty: 96,
    }));

    const snapshot = await payoutSnapshotService.createSnapshotForTemplate({
      blockHeight: 900020,
      coinbaseValueSats: 100000,
      networkDifficulty: 100000,
    });

    expect(snapshot).toEqual(expect.objectContaining({
      method: 'pplns',
      blockHeight: 900020,
      totalCreditedDifficulty: 96,
      totalAcceptedShareCount: 2,
      eligibleAddressCount: 2,
      includedOutputCount: 2,
      distributedSats: '100000',
    }));
    expect(snapshot.payoutOutputs).toEqual([
      { address: clients[0].address, amountSats: 66667, percent: 66.667 },
      { address: clients[1].address, amountSats: 33333, percent: 33.333 },
    ]);

    await expect(payoutSnapshotService.finalizeSnapshotForBlock({
      payoutSnapshotId: snapshot.id,
      blockHeight: 900020,
      blockSubmissionResult: 'SUCCESS!',
    })).resolves.toEqual(expect.objectContaining({
      finalized: true,
      payoutSnapshotId: snapshot.id,
      historyRows: 2,
      balanceRows: 2,
    }));

    const historyRows = await dataSource.query(`
      SELECT "address", "paidSats"::int AS "paidSats", "rowType"
      FROM payout_history
      WHERE "blockHeight" = $1
      ORDER BY "paidSats" DESC
    `, [900020]);
    expect(historyRows).toEqual([
      { address: clients[0].address, paidSats: 66667, rowType: 'coinbase' },
      { address: clients[1].address, paidSats: 33333, rowType: 'coinbase' },
    ]);

    await expect(payoutSnapshotService.finalizeSnapshotForBlock({
      payoutSnapshotId: snapshot.id,
      blockHeight: 900020,
      blockSubmissionResult: 'SUCCESS!',
    })).resolves.toEqual(expect.objectContaining({
      finalized: false,
      reason: 'already-finalized',
    }));
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
    );

    await repository.save({
      address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
      clientName: 'idle-live-worker',
      sessionId: '91b2c3d4',
      userAgent,
      startTime: new Date(),
      bestDifficulty: 11,
      hashRate: 0,
    });
    const activeClient = await repository.save({
      address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
      clientName: 'active-live-worker',
      sessionId: '93b2c3d4',
      userAgent,
      startTime: new Date(),
      bestDifficulty: 33,
      hashRate: 300,
    });
    const staleClient = await repository.save({
      address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
      clientName: 'stale-live-worker',
      sessionId: '92b2c3d4',
      userAgent,
      startTime: new Date(),
      bestDifficulty: 22,
      hashRate: 200,
    });
    await repository.softDelete(staleClient.id);

    const rows = await reportService.getReport();
    expect(rows).toEqual(expect.arrayContaining([{
      userAgent,
      count: '1',
      bestDifficulty: Number(activeClient.bestDifficulty),
      totalHashRate: String(activeClient.hashRate),
    }]));
  });

  it('should serve completed chart buckets and omit the current in-progress bucket', async () => {
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
    const currentBucketStart = Math.floor(Date.now() / (10 * 60 * 1000)) * 10 * 60 * 1000;
    const completedBucketStart = currentBucketStart - (10 * 60 * 1000);
    const completedBucketEnd = currentBucketStart;
    const acceptedAt = new Date(completedBucketStart + 1000);

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
    await accountingService.recordAcceptedShare({
      protocol: 'sv1',
      acceptedAt: new Date(currentBucketStart + 1000),
      address: client.address,
      clientName: client.clientName,
      sessionId: client.sessionId,
      clientId: client.id,
      jobId: 'current-bucket',
      jobTemplateId: 'realtime-template',
      blockHeight: 900001,
      creditedDifficulty: 1024,
      submissionDifficulty: 2048,
      networkDifficulty: 100000,
      nonce: 'nonce-current',
      ntime: '64b3f3ec',
      version: '20000000',
      extraNonce2: 'c708000000000000',
      isBlockCandidate: false,
      blockSubmissionResult: null,
    });
    await dataSource.query(
      `CALL refresh_continuous_aggregate('accepted_share_10m', $1::timestamptz, $2::timestamptz)`,
      [new Date(completedBucketStart), new Date(completedBucketEnd)],
    );

    const expectedHashRate = (96 * 4294967296) / 600;
    const expectedChartData = Math.round(expectedHashRate).toString();
    const expectedLiveHashRate = ((96 + 1024) * 4294967296) / 600;
    expect(await statisticsService.getHashRateForGroup(client.address, client.clientName))
      .toBeCloseTo(expectedLiveHashRate);

    const addressChart = await statisticsService.getChartDataForAddress(client.address);
    const groupChart = await statisticsService.getChartDataForGroup(client.address, client.clientName);
    const sessionChart = await statisticsService.getChartDataForSession(client.id);
    const siteChart = await statisticsService.getChartDataForSite();

    for (const chart of [addressChart, groupChart, sessionChart, siteChart]) {
      expect(chart).toEqual(expect.arrayContaining([
        expect.objectContaining({ data: expectedChartData }),
      ]));
      expect(chart).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ label: new Date(currentBucketStart).toISOString() }),
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
