import { ConfigService } from '@nestjs/config';
import * as bitcoinjs from 'bitcoinjs-lib';
import { Socket } from 'net';
import { Observable, Subject } from 'rxjs';

import { StratumV2Client } from '../models/StratumV2Client';
import { Sv1PrestageActivation } from './redis-messaging.service';
import { IJobTemplate } from './stratum-v1-jobs.service';
import { StratumV2Service } from './stratum-v2.service';

describe('StratumV2Service canonical job broadcaster', () => {
  const originalApiOnly = process.env.API_ONLY;
  const originalMaster = process.env.MASTER;
  const originalNamespaceEnv = {
    NODE_APP_INSTANCE: process.env.NODE_APP_INSTANCE,
    pm_id: process.env.pm_id,
    restart_time: process.env.restart_time,
    PM2_ENABLED: process.env.PM2_ENABLED,
    SV2_EXTRANONCE_NAMESPACE_BASE: process.env.SV2_EXTRANONCE_NAMESPACE_BASE,
  };

  beforeEach(() => {
    delete process.env.API_ONLY;
    delete process.env.MASTER;
    for (const key of Object.keys(originalNamespaceEnv)) {
      delete process.env[key];
    }
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env.API_ONLY = originalApiOnly;
    process.env.MASTER = originalMaster;
    for (const [key, value] of Object.entries(originalNamespaceEnv)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    jest.restoreAllMocks();
  });

  it('owns one canonical subscription and fans out without awaiting slow clients', async () => {
    const { service, templates, subscribeSpy } = createService();
    await service.onModuleInit();
    await service.onModuleInit();
    let releaseSlow: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const slowClient = createClientMock(jest.fn(() => slowGate));
    const fastClient = createClientMock();
    service.registerClient(slowClient);
    service.registerClient(fastClient);

    templates.next(createJobTemplate('1', 'all'));

    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(slowClient.enqueueCanonicalJob).toHaveBeenCalledTimes(1);
    expect(fastClient.enqueueCanonicalJob).toHaveBeenCalledTimes(1);
    releaseSlow();
    await slowGate;
    await service.onModuleDestroy();
  });

  it('isolates a failed client and continues the same fanout', async () => {
    const { service, templates } = createService();
    await service.onModuleInit();
    const failedClient = createClientMock(
      jest.fn(() => {
        throw new Error('socket failed');
      }),
    );
    const healthyClient = createClientMock();
    service.registerClient(failedClient);
    service.registerClient(healthyClient);

    templates.next(createJobTemplate('2', 'all'));

    expect(failedClient.destroy).toHaveBeenCalledTimes(1);
    expect(healthyClient.enqueueCanonicalJob).toHaveBeenCalledTimes(1);
    expect((service as any).clients.has(failedClient)).toBe(false);
    await service.onModuleDestroy();
  });

  it('removes an asynchronously failed client without blocking later broadcasts', async () => {
    const { service, templates } = createService();
    await service.onModuleInit();
    const failedClient = createClientMock(
      jest.fn().mockRejectedValue(new Error('async socket failure')),
    );
    const healthyClient = createClientMock();
    service.registerClient(failedClient);
    service.registerClient(healthyClient);

    templates.next(createJobTemplate('async-failure', 'all'));
    await Promise.resolve();
    await Promise.resolve();

    expect(failedClient.destroy).toHaveBeenCalledTimes(1);
    expect((service as any).clients.has(failedClient)).toBe(false);
    expect(healthyClient.enqueueCanonicalJob).toHaveBeenCalledTimes(1);

    templates.next(createJobTemplate('after-failure', 'all'));
    expect(healthyClient.enqueueCanonicalJob).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
  });

  it('tracks the latest canonical template independently by payout mode', async () => {
    const { service, templates } = createService();
    await service.onModuleInit();
    const shared = createJobTemplate('shared', 'all');
    const solo = createJobTemplate('solo', 'solo');
    const pplns = createJobTemplate('pplns', 'pplns');

    templates.next(shared);
    expect(service.getLatestCanonicalJob('solo')).toBe(shared);
    expect(service.getLatestCanonicalJob('pplns')).toBe(shared);

    templates.next(solo);
    templates.next(pplns);
    expect(service.getLatestCanonicalJob('solo')).toBe(solo);
    expect(service.getLatestCanonicalJob('pplns')).toBe(pplns);
    await service.onModuleDestroy();
  });

  it('owns one activation subscription, deduplicates payout envelopes, and fans out without awaiting', async () => {
    const {
      service,
      activations,
      activationSubscribeSpy,
    } = createService();
    await service.onModuleInit();
    await service.onModuleInit();
    let releaseSlow: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const slowClient = createClientMock(undefined, jest.fn(() => slowGate));
    const fastClient = createClientMock();
    service.registerClient(slowClient);
    service.registerClient(fastClient);

    const solo = createActivationTemplate(900_001, '11'.repeat(32), 'solo');
    activations.next(solo);
    activations.next({ ...solo, payoutMode: 'pplns' });

    expect(activationSubscribeSpy).toHaveBeenCalledTimes(1);
    expect(slowClient.enqueueWorkActivation).toHaveBeenCalledTimes(1);
    expect(fastClient.enqueueWorkActivation).toHaveBeenCalledTimes(1);
    expect(service.getLatestWorkActivationTemplate()).toBe(solo);
    releaseSlow();
    await slowGate;
    await service.onModuleDestroy();
  });

  it('converts compact activations into header-only SV2 work activation fanout', async () => {
    const { service, compactActivations } = createService();
    await service.onModuleInit();
    const client = createClientMock();
    service.registerClient(client);

    compactActivations.next(createCompactActivation(900_002, '22'.repeat(32)));

    expect(client.enqueueWorkActivation).toHaveBeenCalledTimes(1);
    expect(client.enqueueWorkActivation).toHaveBeenCalledWith(expect.objectContaining({
      height: 900_002,
      previousblockhash: '22'.repeat(32),
      transactions: [],
      jobType: 'empty',
      version: 0x20000000,
      bits: '1d00ffff',
      mintime: 1_700_000_002,
    }));
    expect(service.getLatestWorkActivationTemplate()).toEqual(expect.objectContaining({
      height: 900_002,
      notificationEventId: 'compact-900002',
    }));
    await service.onModuleDestroy();
  });

  it('deduplicates a legacy bridge that follows the compact activation for the same tip', async () => {
    const { service, activations, compactActivations } = createService();
    await service.onModuleInit();
    const client = createClientMock();
    service.registerClient(client);
    const previousBlockHash = '33'.repeat(32);

    compactActivations.next(createCompactActivation(900_003, previousBlockHash));
    activations.next(createActivationTemplate(900_003, previousBlockHash, 'solo'));

    expect(client.enqueueWorkActivation).toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
  });

  it('registers created clients and unregisters them during client destruction', async () => {
    const { service } = createService();
    (service as any).noiseConfig = createNoiseConfig();
    const socket = createSocket();

    const client = service.createClient(socket, Buffer.alloc(0));
    expect((service as any).clients.has(client)).toBe(true);

    await client.destroy();
    expect((service as any).clients.has(client)).toBe(false);
  });

  it('allocates one collision-free prefix space across channel types, workers, and reloads', () => {
    const allocateBothChannelTypes = (service: StratumV2Service): Buffer[] => {
      const standardChannelId = service.getNextChannelId();
      const standard = service.generateExtranoncePrefix(standardChannelId);
      const extendedChannelId = service.getNextChannelId();
      const extended = service.allocateExtendedExtranoncePrefix(extendedChannelId);
      expect(service.getExtendedMinerExtranonceSize()).toBe(10);
      expect(service.getExtendedTotalExtranonceSize()).toBe(14);
      return [standard, extended];
    };

    process.env.NODE_APP_INSTANCE = '0';
    process.env.restart_time = '0';
    const worker0 = allocateBothChannelTypes(createService().service);

    process.env.NODE_APP_INSTANCE = '1';
    process.env.restart_time = '0';
    const worker1 = allocateBothChannelTypes(createService().service);

    process.env.NODE_APP_INSTANCE = '0';
    process.env.restart_time = '1';
    const reloadedWorker0 = allocateBothChannelTypes(createService().service);

    const prefixes = [...worker0, ...worker1, ...reloadedWorker0];
    expect(prefixes.every(prefix => prefix.length === 4)).toBe(true);
    expect(new Set(prefixes.map(prefix => prefix.toString('hex'))).size).toBe(prefixes.length);
    expect(prefixes.map(prefix => prefix[0])).toEqual([0, 0, 2, 2, 1, 1]);
  });

  it('fails worker initialization when PM2 exposes no representable process identity', async () => {
    process.env.PM2_ENABLED = 'true';
    const { service } = createService();

    await expect(service.onModuleInit())
      .rejects.toThrow('cannot allocate collision-free extranonces');
  });

  it('unsubscribes and destroys all registered clients on module shutdown', async () => {
    const { service } = createService();
    await service.onModuleInit();
    const first = createClientMock();
    const second = createClientMock();
    service.registerClient(first);
    service.registerClient(second);
    const subscription = (service as any).canonicalJobSubscription;
    const activationSubscription = (service as any).workActivationSubscription;

    await service.onModuleDestroy();

    expect(subscription.closed).toBe(true);
    expect(activationSubscription.closed).toBe(true);
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(second.destroy).toHaveBeenCalledTimes(1);
    expect((service as any).clients.size).toBe(0);
  });
});

function createService(): {
  service: StratumV2Service;
  templates: Subject<IJobTemplate>;
  subscribeSpy: jest.Mock;
  activations: Subject<any>;
  compactActivations: Subject<Sv1PrestageActivation>;
  activationSubscribeSpy: jest.Mock;
} {
  const templates = new Subject<IJobTemplate>();
  const subscribeSpy = jest.fn((observer) => templates.subscribe(observer));
  const activations = new Subject<any>();
  const compactActivations = new Subject<Sv1PrestageActivation>();
  const activationSubscribeSpy = jest.fn((observer) => activations.subscribe(observer));
  const jobsService = {
    newMiningJob$: new Observable((subscriber) => subscribeSpy(subscriber)),
    getLatestJobTemplate: jest.fn().mockReturnValue(null),
  };
  const configService = {
    get: jest.fn((key: string) => (key === 'NETWORK' ? 'testnet' : null)),
  };
  const clientService = {
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const bitcoinRpcService = {
    workActivationTemplate$: new Observable((subscriber) => activationSubscribeSpy(subscriber)),
    newSv1PrestageActivation$: compactActivations.asObservable(),
  };
  const service = new StratumV2Service(
    bitcoinRpcService as any,
    clientService as any,
    {} as any,
    {} as any,
    configService as unknown as ConfigService,
    jobsService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return { service, templates, subscribeSpy, activations, compactActivations, activationSubscribeSpy };
}

function createClientMock(
  enqueue = jest.fn().mockResolvedValue(undefined),
  enqueueActivation = jest.fn().mockResolvedValue(undefined),
): StratumV2Client & {
  enqueueCanonicalJob: jest.Mock;
  enqueueWorkActivation: jest.Mock;
  destroy: jest.Mock;
} {
  return {
    enqueueCanonicalJob: enqueue,
    enqueueWorkActivation: enqueueActivation,
    destroy: jest.fn().mockResolvedValue(undefined),
  } as any;
}

function createActivationTemplate(
  height: number,
  previousblockhash: string,
  payoutMode: 'solo' | 'pplns',
) {
  return {
    height,
    previousblockhash,
    payoutMode,
    jobType: 'empty',
    version: 0x20000000,
    vbrequired: 0,
    bits: '1d00ffff',
    mintime: 1_700_000_001,
  } as any;
}

function createCompactActivation(
  height: number,
  previousBlockHash: string,
): Sv1PrestageActivation {
  return {
    schemaVersion: 1,
    type: 'prestage-activation',
    eventId: `compact-${height}`,
    height,
    previousBlockHash,
    version: 0x20000000,
    bits: '1d00ffff',
    minTime: 1_700_000_001,
    currentTime: 1_700_000_002,
    subsidySats: 312_500_000,
    payoutMode: 'solo',
    requiredVersionBits: 0,
    publishedAtMs: 1_700_000_000_000,
  };
}

function createJobTemplate(
  id: string,
  payoutMode: 'solo' | 'pplns' | 'all',
): IJobTemplate {
  const block = new bitcoinjs.Block();
  block.timestamp = 1_700_000_000;
  return {
    block,
    merkle_branch: [],
    blockData: {
      id,
      creation: Date.now(),
      coinbasevalue: 312_500_000,
      networkDifficulty: 1,
      height: 900_000,
      tipKey: `900000:${'00'.repeat(32)}`,
      clearJobs: true,
      isNewBlock: true,
      jobType: 'full',
      payoutMode,
    },
  };
}

function createNoiseConfig() {
  return {
    staticKeypair: {
      privateKey: Buffer.alloc(32, 1),
      publicKey: Buffer.alloc(64, 2),
    },
    certificateMessage: {
      version: 0,
      validFrom: 0,
      notValidAfter: 1,
      signature: Buffer.alloc(64),
    },
  };
}

function createSocket(): Socket {
  const socket: any = {
    destroyed: false,
    writableEnded: false,
    on: jest.fn().mockReturnThis(),
    write: jest.fn((_data, callback) => {
      callback?.();
      return true;
    }),
    destroy: jest.fn(function destroy() {
      socket.destroyed = true;
      return socket;
    }),
  };
  return socket as Socket;
}
