import { AppController } from './app.controller';

describe('AppController', () => {
  const createController = (overrides: {
    cacheManager?: any;
    blocksService?: any;
    addressSettingsService?: any;
    userAgentReportService?: any;
    sv2AuthorityService?: any;
    redisMessagingService?: any;
  } = {}) => {
    return new AppController(
      overrides.cacheManager ?? {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
      },
      {} as any,
      {} as any,
      overrides.blocksService ?? {
        getFoundBlocks: jest.fn().mockResolvedValue([]),
      },
      {} as any,
      overrides.addressSettingsService ?? {
        getHighScores: jest.fn().mockResolvedValue([]),
      },
      overrides.userAgentReportService ?? {
        getReport: jest.fn().mockResolvedValue([]),
      },
      overrides.sv2AuthorityService ?? {
        getPoolAuthorityPublicKey: jest.fn().mockResolvedValue({
          publicKey: '',
          configured: false,
        }),
      },
      {} as any,
      overrides.redisMessagingService ?? {
        getJsonCache: jest.fn().mockResolvedValue(null),
        setJsonCache: jest.fn().mockResolvedValue(undefined),
      },
    );
  };

  it('refreshes found blocks even when site info is served from cache', async () => {
    const cachedInfo = {
      blockData: [{ height: 1 }],
      userAgents: [],
      highScores: [],
      sv2: {
        poolAuthorityPublicKey: '',
        authorityKeyConfigured: false,
      },
      uptime: new Date('2026-01-01T00:00:00.000Z'),
    };
    const freshBlocks = [{ height: 2 }];
    const cacheManager = {
      get: jest.fn().mockResolvedValue(cachedInfo),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const blocksService = {
      getFoundBlocks: jest.fn().mockResolvedValue(freshBlocks),
    };
    const controller = createController({
      cacheManager,
      blocksService,
    });

    await expect(controller.info()).resolves.toEqual({
      ...cachedInfo,
      blockData: freshBlocks,
    });
    expect(blocksService.getFoundBlocks).toHaveBeenCalledTimes(1);
  });

  it('keeps small user-agent reports expanded so local protocol workers are visible', async () => {
    const controller = createController({
      userAgentReportService: {
        getReport: jest.fn().mockResolvedValue([
          {
            userAgent: 'unknown/sv2',
            count: '1',
            bestDifficulty: 100,
            totalHashRate: '0',
          },
          {
            userAgent: 'v0.4.1-beta/datum',
            count: '1',
            bestDifficulty: 0,
            totalHashRate: '0',
          },
        ]),
      },
    });

    await expect(controller.info()).resolves.toMatchObject({
      userAgents: [
        {
          userAgent: 'unknown/sv2',
          count: '1',
          bestDifficulty: 100,
          totalHashRate: '0',
        },
        {
          userAgent: 'v0.4.1-beta/datum',
          count: '1',
          bestDifficulty: 0,
          totalHashRate: '0',
        },
      ],
    });
  });

  it('groups small user-agent rows only when the report is large', () => {
    const controller = createController() as any;
    const report = Array.from({ length: 21 }, (_, index) => ({
      userAgent: `small-${index}`,
      count: '1',
      bestDifficulty: index,
      totalHashRate: '0',
    }));

    expect(controller.groupSmallUserAgents(report)).toEqual([
      {
        userAgent: 'Other',
        count: '21',
        bestDifficulty: 20,
        totalHashRate: '0',
      },
    ]);
  });
});
