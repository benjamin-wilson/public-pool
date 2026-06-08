import { Test, TestingModule } from '@nestjs/testing';

import { AddressSettingsService } from '../../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../../ORM/client/client.service';
import { ShareAccountingService } from '../../ORM/share-accounting/share-accounting.service';
import { RedisMessagingService } from '../../services/redis-messaging.service';
import { ClientController } from './client.controller';

describe('ClientController', () => {
  let controller: ClientController;
  let addressSettingsService: { getSettings: jest.Mock };
  let shareAccountingService: {
    getAddressSummary: jest.Mock;
    getWorkerGroupSummary: jest.Mock;
    getSessionSummary: jest.Mock;
    getSessionSummaries: jest.Mock;
  };
  let redisMessagingService: { getClientPresenceByAddress: jest.Mock };

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
                    provide: RedisMessagingService,
                    useValue: {
                        getClientPresenceByAddress: jest.fn().mockResolvedValue([]),
                    },
                },
            ],

        }).compile();

    controller = module.get<ClientController>(ClientController);
    addressSettingsService = module.get(AddressSettingsService);
    shareAccountingService = module.get(ShareAccountingService);
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
});
