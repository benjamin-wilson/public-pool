import { Test, TestingModule } from '@nestjs/testing';

import { AddressSettingsService } from '../../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../../ORM/client/client.service';
import { PayoutSnapshotService } from '../../ORM/payout-snapshot/payout-snapshot.service';
import { ShareAccountingService } from '../../ORM/share-accounting/share-accounting.service';
import { RedisMessagingService } from '../../services/redis-messaging.service';
import { ClientController } from './client.controller';

describe('ClientController', () => {
  let controller: ClientController;
  let clientService: { getBySessionId: jest.Mock; getActiveIds: jest.Mock };
  let addressSettingsService: { getSettings: jest.Mock };
  let shareAccountingService: {
    getAddressSummary: jest.Mock;
    getWorkerGroupSummary: jest.Mock;
    getSessionSummary: jest.Mock;
    getSessionSummaries: jest.Mock;
  };
  let payoutSnapshotService: { getLatestExpectedPayoutForAddress: jest.Mock };
  let redisMessagingService: { getClientPresenceByAddress: jest.Mock; removeClientPresence: jest.Mock };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            controllers: [ClientController],
            providers: [
                {
                    provide: ClientService,
                    useValue: {
                        getByAddress: jest.fn(),
                        getByName: jest.fn(),
                        getBySessionId: jest.fn(),
                        getActiveIds: jest.fn(async (ids: string[]) => new Set(ids)),
                    },
                },
                {
                    provide: ClientStatisticsService,
                    useValue: {
                        getChartDataForAddress: jest.fn(),
                        getChartDataForGroup: jest.fn(),
                        getChartDataForSession: jest.fn(),
                    },
                },
                {
                    provide: AddressSettingsService,
                    useValue: {
                        getSettings: jest.fn(),
                    },
                },
                {
                    provide: ShareAccountingService,
                    useValue: {
                        getAddressSummary: jest.fn(),
                        getWorkerGroupSummary: jest.fn(),
                        getSessionSummary: jest.fn(),
                        getSessionSummaries: jest.fn().mockResolvedValue(new Map()),
                    },
                },
                {
                    provide: PayoutSnapshotService,
                    useValue: {
                        getLatestExpectedPayoutForAddress: jest.fn().mockResolvedValue(null),
                    },
                },
                {
                    provide: RedisMessagingService,
                    useValue: {
                        getClientPresenceByAddress: jest.fn().mockResolvedValue([]),
                        removeClientPresence: jest.fn().mockResolvedValue(undefined),
                    },
                },
            ],

        }).compile();

    controller = module.get<ClientController>(ClientController);
    clientService = module.get(ClientService);
    addressSettingsService = module.get(AddressSettingsService);
    shareAccountingService = module.get(ShareAccountingService);
    payoutSnapshotService = module.get(PayoutSnapshotService);
    redisMessagingService = module.get(RedisMessagingService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should expose the existing address best difficulty in accounting when rollup best is empty', async () => {
    redisMessagingService.getClientPresenceByAddress.mockResolvedValue([
      {
        clientId: '92f5302f-5e32-487e-af67-f56fd78b13c7',
        sessionId: 'abcd1234',
        clientName: 'worker',
        bestDifficulty: 64,
        hashRate: 1024,
        startTime: '2026-06-08T12:00:00.000Z',
        lastSeen: '2026-06-08T12:10:00.000Z',
        address: 'bc1qtest',
      },
    ]);
    addressSettingsService.getSettings.mockResolvedValue({ bestDifficulty: 4096 });
    shareAccountingService.getSessionSummaries.mockResolvedValue(new Map());
    shareAccountingService.getAddressSummary.mockResolvedValue({
      totalAcceptedShares: 10,
      totalCreditedDifficulty: 100,
      bestSubmissionDifficulty: 0,
    });

    await expect(controller.getClientInfo('bc1qtest')).resolves.toEqual(expect.objectContaining({
      bestDifficulty: 4096,
      accounting: expect.objectContaining({
        bestSubmissionDifficulty: 4096,
      }),
    }));
  });

  it('should expose the latest current PPLNS expected payout for an address', async () => {
    addressSettingsService.getSettings.mockResolvedValue(null);
    shareAccountingService.getAddressSummary.mockResolvedValue({
      totalAcceptedShares: 10,
      totalCreditedDifficulty: 100,
      bestSubmissionDifficulty: 0,
    });
    payoutSnapshotService.getLatestExpectedPayoutForAddress.mockResolvedValue({
      snapshotId: '19',
      blockHeight: 900001,
      payoutMode: 'pplns',
      payoutSats: 1234,
      creditedDifficulty: 50,
      percent: 12.34,
    });

    await expect(controller.getClientInfo('bc1qtest')).resolves.toEqual(expect.objectContaining({
      expectedPayout: expect.objectContaining({
        snapshotId: '19',
        payoutSats: 1234,
      }),
    }));
    expect(payoutSnapshotService.getLatestExpectedPayoutForAddress).toHaveBeenCalledWith('bc1qtest');
  });

  it('should not query expected PPLNS payout for solo-only address requests', async () => {
    addressSettingsService.getSettings.mockResolvedValue(null);
    shareAccountingService.getAddressSummary.mockResolvedValue({
      totalAcceptedShares: 10,
      totalCreditedDifficulty: 100,
      bestSubmissionDifficulty: 0,
    });

    await expect(controller.getClientInfo('bc1qtest', 'solo')).resolves.toEqual(expect.objectContaining({
      expectedPayout: null,
    }));
    expect(payoutSnapshotService.getLatestExpectedPayoutForAddress).not.toHaveBeenCalled();
  });

  it('should hide stale Redis workers that are no longer active in the database', async () => {
    redisMessagingService.getClientPresenceByAddress.mockResolvedValue([
      {
        clientId: 'active-client',
        address: 'bc1qtest',
        sessionId: 'active1',
        clientName: 'active-worker',
        bestDifficulty: 64,
        hashRate: 1024,
        startTime: '2026-06-08T12:00:00.000Z',
        lastSeen: '2026-06-08T12:10:00.000Z',
      },
      {
        clientId: 'stale-client',
        address: 'bc1qtest',
        sessionId: 'stale1',
        clientName: 'stale-worker',
        bestDifficulty: 128,
        hashRate: 2048,
        startTime: '2026-06-08T12:00:00.000Z',
        lastSeen: '2026-06-08T12:10:00.000Z',
      },
    ]);
    clientService.getActiveIds.mockResolvedValue(new Set(['active-client']));
    addressSettingsService.getSettings.mockResolvedValue(null);
    shareAccountingService.getSessionSummaries.mockResolvedValue(new Map());
    shareAccountingService.getAddressSummary.mockResolvedValue({
      totalAcceptedShares: 0,
      totalCreditedDifficulty: 0,
      bestSubmissionDifficulty: 0,
    });

    await expect(controller.getClientInfo('bc1qtest')).resolves.toMatchObject({
      workersCount: 1,
      workers: [
        {
          sessionId: 'active1',
          name: 'active-worker',
        },
      ],
    });
    expect(redisMessagingService.removeClientPresence)
      .toHaveBeenCalledWith('stale-client', 'bc1qtest');
  });
});
