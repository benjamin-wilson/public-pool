import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Controller, Get, Inject } from '@nestjs/common';
import { Cache } from 'cache-manager';
import { firstValueFrom } from 'rxjs';

import { UserAgentReportService } from './ORM/_views/user-agent-report/user-agent-report.service';
import { AddressSettingsService } from './ORM/address-settings/address-settings.service';
import { BlocksService } from './ORM/blocks/blocks.service';
import { ClientStatisticsService } from './ORM/client-statistics/client-statistics.service';
import { ClientService } from './ORM/client/client.service';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';
import { UserAgentReportView } from './ORM/_views/user-agent-report/user-agent-report.view';
import { StratumV2Service } from './services/stratum-v2.service';
import { ShareAccountingService } from './ORM/share-accounting/share-accounting.service';
import { RedisMessagingService } from './services/redis-messaging.service';

@Controller()
export class AppController {

  private uptime = new Date();

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly clientService: ClientService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly blocksService: BlocksService,
    private readonly bitcoinRpcService: BitcoinRpcService,
    private readonly addressSettingsService: AddressSettingsService,
    private readonly userAgentReportService: UserAgentReportService,
    private readonly stratumV2Service: StratumV2Service,
    private readonly shareAccountingService: ShareAccountingService,
    private readonly redisMessagingService: RedisMessagingService
  ) { }

  @Get('info')
  public async info() {


    const CACHE_KEY = 'SITE_INFO';
    const cachedResult = await this.getCached(CACHE_KEY, 5 * 60 * 1000);

    if (cachedResult != null) {
      return cachedResult;
    }

    let usedFallback = false;
    const withInfoTimeout = async <T>(label: string, promise: Promise<T>, fallback: T): Promise<T> => {
      return await this.withTimeout(label, promise, fallback, () => {
        usedFallback = true;
      });
    };

    const [blockData, highScores, poolAuthority, userAgentReport] = await Promise.all([
      withInfoTimeout('found blocks', this.blocksService.getFoundBlocks(), []),
      withInfoTimeout('high scores', this.addressSettingsService.getHighScores(), []),
      withInfoTimeout('SV2 authority', this.stratumV2Service.getPoolAuthorityPublicKey(), {
        publicKey: '',
        configured: false
      }),
      withInfoTimeout<UserAgentReportView[]>('user agent report', this.userAgentReportService.getReport(), []),
    ]);

    const other: {
      count: number,
      bestDifficulty: number,
      totalHashRate: number;
    } = {
      count: 0,
      bestDifficulty: 0,
      totalHashRate: 0
    };
    const userAgents: UserAgentReportView[] = userAgentReport.reduce((pre, cur, idx, arr) => {
      // If less than 10Th/s and less than 100 devices, add to 'other'
      if (parseInt(cur.totalHashRate) < 10000000000000 && parseInt(cur.count) < 200) {
        other.totalHashRate += parseFloat(cur.totalHashRate);
        other.count += parseInt(cur.count);
        if (other.bestDifficulty < cur.bestDifficulty) {
          other.bestDifficulty = cur.bestDifficulty;
        }
      } else {
        pre.push(cur);
      }
      return pre;
    }, []);

    if (other.count > 0) {
      userAgents.push({ userAgent: 'Other', count: other.count.toString(), bestDifficulty: other.bestDifficulty, totalHashRate: other.totalHashRate.toString() })
    }

    const data = {
      blockData,
      userAgents,
      highScores,
      sv2: {
        poolAuthorityPublicKey: poolAuthority.publicKey,
        authorityKeyConfigured: poolAuthority.configured
      },
      uptime: this.uptime
    };

    // Match the pre-Timescale dashboard cache behavior; live accounting is exposed separately.
    await this.setCached(CACHE_KEY, data, usedFallback ? 15 * 1000 : 5 * 60 * 1000);

    return data;

  }

  @Get('info/accounting')
  public async infoAccounting() {
    const CACHE_KEY = 'SITE_ACCOUNTING';
    const cachedResult = await this.getCached(CACHE_KEY, 15 * 1000);

    if (cachedResult != null) {
      return cachedResult;
    }

    const data = await this.shareAccountingService.getPoolSummary();

    //15 sec
    await this.setCached(CACHE_KEY, data, 15 * 1000);

    return data;
  }

  @Get('pool')
  public async pool() {

    const CACHE_KEY = 'POOL_INFO';
    const cachedResult = await this.getCached(CACHE_KEY, 15 * 1000);

    if (cachedResult != null) {
      return cachedResult;
    }

    const userAgents = await this.userAgentReportService.getReport();

    const totalHashRate = userAgents.reduce((acc, userAgent) => acc + parseFloat(userAgent.totalHashRate), 0);
    const totalMiners = userAgents.reduce((acc, userAgent) => acc + parseFloat(userAgent.count), 0);
    const blockHeight = this.bitcoinRpcService.miningInfo.blocks;
    const blocksFound = await this.blocksService.getFoundBlocks();

    const data = {
      totalHashRate,
      blockHeight,
      totalMiners,
      blocksFound,
      fee: 0
    }

    // Keep online miner counts responsive after reconnect cleanup.
    await this.setCached(CACHE_KEY, data, 15 * 1000);

    return data;
  }

  @Get('network')
  public async network() {
    return this.bitcoinRpcService.miningInfo ?? {};
  }

  @Get('info/chart')
  public async infoChart() {


    const CACHE_KEY = 'SITE_HASHRATE_GRAPH';
    const cachedResult = await this.getCached(CACHE_KEY, 10 * 60 * 1000);

    if (cachedResult != null) {
      return cachedResult;
    }

    const chartData = await this.clientStatisticsService.getChartDataForSite();

    //10 min
    await this.setCached(CACHE_KEY, chartData, 10 * 60 * 1000);

    return chartData;


  }

  private async getCached<T>(key: string, localTtlMs: number): Promise<T | null> {
    const local = await this.cacheManager.get<T>(key);
    if (local != null) {
      return local;
    }

    const shared = await this.withSecondaryCacheTimeout(
      this.redisMessagingService.getJsonCache<T>(`api:${key}`).catch(error => {
        console.error(`Shared API cache read failed for ${key}: ${error.message}`);
        return null;
      }),
      100
    );
    if (shared != null) {
      await this.cacheManager.set(key, shared, localTtlMs);
      return shared;
    }

    return null;
  }

  private async setCached(key: string, value: unknown, ttlMs: number): Promise<void> {
    await this.cacheManager.set(key, value, ttlMs);
    void this.redisMessagingService.setJsonCache(`api:${key}`, value, ttlMs).catch(error => {
      console.error(`Shared API cache write failed for ${key}: ${error.message}`);
    });
  }

  private async withTimeout<T>(
    label: string,
    promise: Promise<T>,
    fallback: T,
    onTimeout: () => void,
    timeoutMs = 1500
  ): Promise<T> {
    let timeout: NodeJS.Timeout;
    const timeoutPromise = new Promise<T>(resolve => {
      timeout = setTimeout(() => {
        onTimeout();
        console.error(`/api/info ${label} timed out after ${timeoutMs}ms`);
        resolve(fallback);
      }, timeoutMs);
      timeout.unref?.();
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async withSecondaryCacheTimeout<T>(promise: Promise<T | null>, timeoutMs: number): Promise<T | null> {
    let timeout: NodeJS.Timeout;
    const timeoutPromise = new Promise<null>(resolve => {
      timeout = setTimeout(() => resolve(null), timeoutMs);
      timeout.unref?.();
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeout);
    }
  }

}
