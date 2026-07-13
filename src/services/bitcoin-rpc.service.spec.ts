import { ConfigService } from '@nestjs/config';

import { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { MockRecording1 } from '../../test/models/MockRecording1';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { calculateBlockSubsidySats } from './subsidy-only-template.factory';

describe('BitcoinRpcService template publication', () => {
    const createTemplate = (): IBlockTemplate => ({
        ...MockRecording1.BLOCK_TEMPLATE,
        transactions: MockRecording1.BLOCK_TEMPLATE.transactions.map(tx => ({ ...tx })),
    });

    it('publishes solo work before an unresolved PPLNS snapshot and persistence', async () => {
        const order: string[] = [];
        let resolveSnapshot: (value: any) => void;
        const snapshotPromise = new Promise(resolve => { resolveSnapshot = resolve; });
        let resolvePersistence: () => void;
        const persistencePromise = new Promise<void>(resolve => { resolvePersistence = resolve; });
        const redis = createRedisMock(order);
        const rpcBlock = {
            saveBlock: jest.fn(() => {
                order.push('postgres:start');
                return persistencePromise;
            }),
            getSavedBlockTemplate: jest.fn(),
        };
        const payoutSnapshots = {
            createSnapshotForTemplate: jest.fn(() => {
                order.push('snapshot:start');
                return snapshotPromise;
            }),
        };
        const service = new BitcoinRpcService(
            { get: jest.fn() } as unknown as ConfigService,
            rpcBlock as any,
            redis as any,
            payoutSnapshots as any,
        );
        service.miningInfo = { blocks: createTemplate().height - 1 } as any;
        jest.spyOn(service as any, 'fetchBlockTemplate').mockResolvedValue(createTemplate());

        await service.getAndBroadcastLatestTemplate('new_block');

        expect(order.indexOf('redis:set:solo')).toBeLessThan(order.indexOf('redis:publish:solo'));
        expect(order.indexOf('redis:publish:solo')).toBeLessThan(order.indexOf('snapshot:start'));
        expect(redis.setBlockTemplate).toHaveBeenCalledTimes(1);
        expect(redis.setBlockTemplate.mock.calls[0][1]).toEqual(expect.objectContaining({
            payoutMode: 'solo',
            payoutSnapshotId: undefined,
        }));

        resolveSnapshot!({
            id: '91',
            payoutOutputs: [{ address: 'bc1qexample', amountSats: 1 }],
        });
        await flushPromises();

        expect(redis.setBlockTemplate).toHaveBeenCalledTimes(2);
        expect(redis.setBlockTemplate.mock.calls[1][1]).toEqual(expect.objectContaining({
            payoutMode: 'pplns',
            payoutSnapshotId: '91',
            forceCleanJobs: true,
        }));
        expect(order.indexOf('snapshot:start')).toBeLessThan(order.indexOf('redis:set:pplns'));
        expect(order.indexOf('redis:set:pplns')).toBeLessThan(order.indexOf('redis:set:legacy:pplns'));
        expect(order.indexOf('redis:set:legacy:pplns')).toBeLessThan(order.indexOf('redis:publish:mining-info'));

        resolvePersistence!();
        await flushPromises();
    });

    it.each(['null', 'error', 'empty'] as const)(
        'never wakes legacy PPLNS listeners with solo fallback work after a %s snapshot result',
        async outcome => {
            const redis = createRedisMock([]);
            const template = createTemplate();
            const createSnapshotForTemplate = jest.fn();
            if (outcome === 'null') {
                createSnapshotForTemplate.mockResolvedValue(null);
            } else if (outcome === 'error') {
                createSnapshotForTemplate.mockRejectedValue(new Error('snapshot unavailable'));
            } else {
                createSnapshotForTemplate.mockResolvedValue({ id: 'empty-snapshot', payoutOutputs: [] });
            }
            const service = new BitcoinRpcService(
                createConfig({
                    SV1_SUBSIDY_BRIDGE_ENABLED: 'false',
                    PPLNS_STRATUM_PORTS: '13333',
                }),
                { saveBlock: jest.fn().mockResolvedValue(undefined), getSavedBlockTemplate: jest.fn() } as any,
                redis as any,
                { createSnapshotForTemplate } as any,
            );
            service.miningInfo = { blocks: template.height - 1 } as any;
            jest.spyOn(service as any, 'fetchBlockTemplate').mockResolvedValue(template);
            const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

            await service.getAndBroadcastLatestTemplate('new_block');
            await flushPromises();

            expect(redis.setBlockTemplate).toHaveBeenCalledTimes(1);
            expect(redis.setLegacyBlockTemplate).not.toHaveBeenCalled();
            expect(redis.setLatestMiningInfo).not.toHaveBeenCalled();
            expect(redis.publishMiningInfoUpdate).not.toHaveBeenCalled();
            errorSpy.mockRestore();
            warnSpy.mockRestore();
        },
    );

    it('keeps the legacy solo fallback for rolling deployments with no PPLNS listeners', async () => {
        const redis = createRedisMock([]);
        const template = createTemplate();
        const service = new BitcoinRpcService(
            createConfig({ SV1_SUBSIDY_BRIDGE_ENABLED: 'false' }),
            { saveBlock: jest.fn().mockResolvedValue(undefined), getSavedBlockTemplate: jest.fn() } as any,
            redis as any,
            { createSnapshotForTemplate: jest.fn().mockResolvedValue(null) } as any,
        );
        service.miningInfo = { blocks: template.height - 1 } as any;
        jest.spyOn(service as any, 'fetchBlockTemplate').mockResolvedValue(template);

        await service.getAndBroadcastLatestTemplate('new_block');
        await flushPromises();

        expect(redis.setLegacyBlockTemplate).toHaveBeenCalledWith(
            template.height - 1,
            expect.objectContaining({ payoutMode: 'solo' }),
        );
        expect(redis.publishMiningInfoUpdate).toHaveBeenCalledTimes(1);
    });

    it.each([
        'PPLNS_STRATUM_PORTS',
        'PPLNS_SECURE_STRATUM_PORTS',
        'PPLNS_STRATUM_V2_PORTS',
        'PPLNS_SV2_JDP_PORTS',
        'PPLNS_SV2_TDP_PORTS',
        'PPLNS_DATUM_PORTS',
    ])('recognizes %s as a legacy PPLNS rollout guard', key => {
        const service = new BitcoinRpcService(
            createConfig({ [key]: ' 13333 ' }),
            {} as any,
            {} as any,
        );

        expect((service as any).hasConfiguredPplnsListeners()).toBe(true);
    });

    it('stores periodic solo and PPLNS refreshes without forcing a clean switch', async () => {
        const redis = createRedisMock([]);
        const rpcBlock = { saveBlock: jest.fn().mockResolvedValue(undefined), getSavedBlockTemplate: jest.fn() };
        const payoutSnapshots = {
            createSnapshotForTemplate: jest.fn().mockResolvedValue({
                id: '92',
                payoutOutputs: [{ address: 'bc1qperiodic', amountSats: 1 }],
            }),
        };
        const service = new BitcoinRpcService(
            { get: jest.fn() } as unknown as ConfigService,
            rpcBlock as any,
            redis as any,
            payoutSnapshots as any,
        );
        const template = createTemplate();
        service.miningInfo = { blocks: template.height - 1 } as any;
        (service as any).lastPublishedTipKey = `${template.height}:${template.previousblockhash}`;
        (service as any).lastPublishedCandidateHeight = template.height;
        jest.spyOn(service as any, 'fetchBlockTemplate').mockResolvedValue(template);

        await service.getAndBroadcastLatestTemplate('periodic');
        await flushPromises();

        expect(redis.setBlockTemplate.mock.calls.map(call => call[1].forceCleanJobs)).toEqual([false, false]);
    });

    it('forces both payout modes clean when longpoll is first to report a new tip', async () => {
        const redis = createRedisMock([]);
        const template = createTemplate();
        const service = new BitcoinRpcService(
            createConfig({ SV1_SUBSIDY_BRIDGE_ENABLED: 'false' }),
            { saveBlock: jest.fn().mockResolvedValue(undefined), getSavedBlockTemplate: jest.fn() } as any,
            redis as any,
            {
                createSnapshotForTemplate: jest.fn().mockResolvedValue({
                    id: 'longpoll-pplns',
                    payoutOutputs: [{ address: 'bc1qlongpoll', amountSats: 1 }],
                }),
            } as any,
        );
        service.miningInfo = { blocks: template.height - 1 } as any;
        jest.spyOn(service as any, 'fetchBlockTemplate').mockResolvedValue(template);

        await service.getAndBroadcastLatestTemplate('longpoll', template.longpollid);
        await flushPromises();

        expect(redis.setBlockTemplate.mock.calls.map(call => call[1].forceCleanJobs))
            .toEqual([true, true]);
    });

    it('publishes a consensus-subsidy bridge before traversing or serializing the full body', async () => {
        const order: string[] = [];
        const redis = createRedisMock(order);
        const template = createTemplate();
        template.height = 840_000;
        template.coinbasevalue = 312_500_000
            + template.transactions.reduce((sum, transaction) => sum + transaction.fee, 0);
        const service = new BitcoinRpcService(
            {
                get: jest.fn((key: string) => key === 'NETWORK' ? 'mainnet' : undefined),
            } as unknown as ConfigService,
            { saveBlock: jest.fn().mockResolvedValue(undefined), getSavedBlockTemplate: jest.fn() } as any,
            redis as any,
            { createSnapshotForTemplate: jest.fn().mockResolvedValue(null) } as any,
        );
        service.miningInfo = { blocks: template.height - 1 } as any;
        jest.spyOn(service as any, 'fetchBlockTemplate').mockResolvedValue(template);

        await service.getAndBroadcastLatestTemplate('new_block');

        expect(redis.publishSv1BridgeUpdate).toHaveBeenCalledWith(expect.objectContaining({
            schemaVersion: 1,
            type: 'subsidy-bridge',
            template: expect.objectContaining({
                height: 840_000,
                coinbasevalue: 312_500_000,
                transactions: [],
                payoutMode: 'solo',
                jobType: 'empty',
                forceCleanJobs: true,
            }),
        }));
        expect(redis.publishSv1BridgeUpdate).toHaveBeenCalledTimes(1);
        expect(order.indexOf('redis:publish:bridge:solo')).toBeLessThan(order.indexOf('redis:set:solo'));
        expect(order.indexOf('redis:publish:bridge:solo')).toBeLessThan(order.indexOf('redis:publish:solo'));
    });

    it('rejects an urgent bridge when Core fee data cannot validate its subsidy', async () => {
        const redis = createRedisMock([]);
        const template = createTemplateAtHeight(840_000, '70');
        Object.defineProperty(template.transactions[0], 'fee', {
            get: () => {
                throw new Error('full transaction body was traversed');
            },
        });
        const service = new BitcoinRpcService(
            createConfig({ NETWORK: 'mainnet' }),
            {} as any,
            redis as any,
        );
        const trace = (service as any).startTrace('new_block', Date.now());
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

        await expect((service as any).publishSoloSubsidyBridge(template, trace))
            .resolves.toBe('failed');
        expect(redis.publishSv1BridgeUpdate).not.toHaveBeenCalled();
        consoleSpy.mockRestore();
    });

    it('rejects an urgent bridge when Core coinbasevalue is not subsidy plus fees', async () => {
        const redis = createRedisMock([]);
        const template = createTemplateAtHeight(840_000, '79');
        template.coinbasevalue += 1;
        const service = new BitcoinRpcService(
            createConfig({ NETWORK: 'mainnet' }),
            {} as any,
            redis as any,
        );
        const trace = (service as any).startTrace('new_block', Date.now());
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

        await expect((service as any).publishSoloSubsidyBridge(template, trace))
            .resolves.toBe('failed');
        expect(redis.publishSv1BridgeUpdate).not.toHaveBeenCalled();
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(
            'does not equal subsidy',
        ));
        consoleSpy.mockRestore();
    });

    it('precomputes an exact next-height PPLNS subsidy seed off the canonical path', async () => {
        const order: string[] = [];
        const canonical = createTemplateAtHeight(839_999, '66');
        let resolveSeed: (value: any) => void;
        const seedPromise = new Promise(resolve => { resolveSeed = resolve; });
        const payoutSnapshots = {
            createSnapshotForTemplate: jest.fn((input: { blockHeight: number; coinbaseValueSats: number }) => {
                if (input.blockHeight === 840_000) {
                    order.push('seed:start');
                    return seedPromise;
                }
                return Promise.resolve(null);
            }),
        };
        const redis = createRedisMock(order);
        const service = new BitcoinRpcService(
            createConfig({
                NETWORK: 'mainnet',
                SV1_SUBSIDY_BRIDGE_PAYOUT_MODES: 'pplns',
            }),
            { saveBlock: jest.fn().mockResolvedValue(undefined), getSavedBlockTemplate: jest.fn() } as any,
            redis as any,
            payoutSnapshots as any,
        );
        service.miningInfo = { blocks: canonical.height - 1 } as any;
        jest.spyOn(service as any, 'fetchBlockTemplate').mockResolvedValue(canonical);

        await service.getAndBroadcastLatestTemplate('periodic');
        await flushPromises();

        expect(order.indexOf('redis:publish:solo')).toBeLessThan(order.indexOf('seed:start'));
        expect(payoutSnapshots.createSnapshotForTemplate).toHaveBeenCalledWith({
            blockHeight: 840_000,
            coinbaseValueSats: 312_500_000,
            networkDifficulty: expect.any(Number),
            visibility: 'bridge_seed',
        });

        resolveSeed!(createSeedSnapshot(840_000, 312_500_000));
        await (service as any).pplnsSeedPrecomputeTail;
        const seeds = (service as any).pplnsSubsidyBridgeSeeds as Map<number, any>;
        expect(seeds.get(840_000)).toEqual(expect.objectContaining({
            candidateHeight: 840_000,
            subsidySats: 312_500_000,
            basisBits: canonical.bits,
            payoutSnapshotId: 'seed-840000',
            preparedAtMs: expect.any(Number),
        }));

        (service as any).storePplnsSubsidyBridgeSeed({
            ...seeds.get(840_000),
            candidateHeight: 840_001,
        });
        (service as any).storePplnsSubsidyBridgeSeed({
            ...seeds.get(840_000),
            candidateHeight: 840_002,
        });
        expect([...seeds.keys()].sort()).toEqual([840_001, 840_002]);
    });

    it('coalesces slow PPLNS seed preparation to the newest pending template', async () => {
        const older = createTemplateAtHeight(839_998, '67');
        const latest = createTemplateAtHeight(839_999, '68');
        let resolveOlder: (value: any) => void;
        const olderSnapshot = new Promise(resolve => { resolveOlder = resolve; });
        const payoutSnapshots = {
            createSnapshotForTemplate: jest.fn()
                .mockReturnValueOnce(olderSnapshot)
                .mockResolvedValueOnce(createSeedSnapshot(840_000, 312_500_000)),
        };
        const service = new BitcoinRpcService(
            createConfig({
                NETWORK: 'mainnet',
                SV1_SUBSIDY_BRIDGE_PAYOUT_MODES: 'pplns',
            }),
            {} as any,
            createRedisMock([]) as any,
            payoutSnapshots as any,
        );

        (service as any).queuePplnsSubsidyBridgeSeedPrecompute(older);
        (service as any).queuePplnsSubsidyBridgeSeedPrecompute(latest);
        expect(payoutSnapshots.createSnapshotForTemplate).toHaveBeenCalledTimes(1);
        resolveOlder!(createSeedSnapshot(839_999, 312_500_000));
        await (service as any).pplnsSeedPrecomputeTail;

        expect(payoutSnapshots.createSnapshotForTemplate).toHaveBeenCalledTimes(2);
        expect([...((service as any).pplnsSubsidyBridgeSeeds as Map<number, any>).keys()])
            .toEqual([840_000]);
    });

    it('coalesces active PPLNS snapshot publication to the newest pending template', async () => {
        const older = createTemplateAtHeight(839_998, '69');
        const middle = createTemplateAtHeight(839_999, '6a');
        const latest = createTemplateAtHeight(840_000, '6b');
        let resolveOlder: (value: any) => void;
        const olderSnapshot = new Promise(resolve => { resolveOlder = resolve; });
        const payoutSnapshots = {
            createSnapshotForTemplate: jest.fn()
                .mockReturnValueOnce(olderSnapshot)
                .mockResolvedValueOnce(null),
        };
        const service = new BitcoinRpcService(
            createConfig({ SV1_SUBSIDY_BRIDGE_ENABLED: 'false' }),
            {} as any,
            createRedisMock([]) as any,
            payoutSnapshots as any,
        );
        const enqueue = (template: IBlockTemplate, eventId: string) => {
            (service as any).queuePplnsTemplatePublication({
                blockTemplate: template,
                soloTemplate: { ...template, payoutMode: 'solo' },
                tipHeight: template.height - 1,
                forceCleanJobs: false,
                tipKey: `${template.height}:${template.previousblockhash}`,
                templateSignature: eventId,
                trace: (service as any).startTrace('periodic'),
            });
        };

        enqueue(older, 'active-older');
        enqueue(middle, 'active-middle');
        enqueue(latest, 'active-latest');
        expect(payoutSnapshots.createSnapshotForTemplate).toHaveBeenCalledTimes(1);

        resolveOlder!(null);
        await (service as any).pplnsTemplatePublicationPromise;

        expect(payoutSnapshots.createSnapshotForTemplate).toHaveBeenCalledTimes(2);
        expect(payoutSnapshots.createSnapshotForTemplate.mock.calls.map(call => call[0].blockHeight))
            .toEqual([older.height, latest.height]);
    });

    it('preserves a required clean PPLNS switch when a same-tip refresh is coalesced', async () => {
        const template = createTemplateAtHeight(840_000, '6c');
        const refreshed = {
            ...template,
            curtime: template.curtime + 1,
            longpollid: `${template.longpollid}:refresh`,
        };
        let resolveFirst: (value: any) => void;
        const firstSnapshot = new Promise(resolve => { resolveFirst = resolve; });
        const service = new BitcoinRpcService(
            createConfig({ SV1_SUBSIDY_BRIDGE_ENABLED: 'false' }),
            {} as any,
            createRedisMock([]) as any,
            {
                createSnapshotForTemplate: jest.fn()
                    .mockReturnValueOnce(firstSnapshot)
                    .mockResolvedValueOnce(null),
            } as any,
        );
        const enqueue = (blockTemplate: IBlockTemplate, forceCleanJobs: boolean) => {
            (service as any).queuePplnsTemplatePublication({
                blockTemplate,
                soloTemplate: { ...blockTemplate, payoutMode: 'solo' },
                tipHeight: blockTemplate.height - 1,
                forceCleanJobs,
                tipKey: `${blockTemplate.height}:${blockTemplate.previousblockhash}`,
                templateSignature: blockTemplate.longpollid,
                trace: (service as any).startTrace('periodic'),
            });
        };

        enqueue(template, true);
        enqueue(refreshed, false);

        expect((service as any).pendingPplnsTemplatePublication.forceCleanJobs).toBe(true);
        resolveFirst!(null);
        await (service as any).pplnsTemplatePublicationPromise;
    });

    it('publishes solo then seeded PPLNS bridges before the full template', async () => {
        const order: string[] = [];
        const redis = createRedisMock(order);
        const template = createTemplateAtHeight(840_000, '77');
        const service = new BitcoinRpcService(
            createConfig({
                NETWORK: 'mainnet',
                SV1_SUBSIDY_BRIDGE_PAYOUT_MODES: ' solo, PPLNS ',
            }),
            { saveBlock: jest.fn().mockResolvedValue(undefined), getSavedBlockTemplate: jest.fn() } as any,
            redis as any,
            { createSnapshotForTemplate: jest.fn().mockResolvedValue(null) } as any,
        );
        const preparedAtMs = Date.now();
        (service as any).storePplnsSubsidyBridgeSeed({
            candidateHeight: template.height,
            subsidySats: 312_500_000,
            basisBits: template.bits,
            payoutSnapshotId: 'seed-for-next-tip',
            payoutOutputs: [
                { address: 'bc1qseed-a', amountSats: 200_000_000 },
                { address: 'bc1qseed-b', amountSats: 112_500_000 },
            ],
            preparedAtMs,
        });
        service.miningInfo = { blocks: template.height - 1 } as any;
        jest.spyOn(service as any, 'fetchBlockTemplate').mockResolvedValue(template);

        await service.getAndBroadcastLatestTemplate('new_block');

        expect(order.indexOf('redis:publish:bridge:solo')).toBeLessThan(
            order.indexOf('redis:publish:bridge:pplns'),
        );
        expect(order.indexOf('redis:publish:bridge:pplns')).toBeLessThan(
            order.indexOf('redis:set:solo'),
        );
        const [soloUpdate, pplnsUpdate] = redis.publishSv1BridgeUpdate.mock.calls
            .map(call => call[0]) as any[];
        expect(soloUpdate.template.notificationEventId).toBe(soloUpdate.eventId);
        expect(pplnsUpdate).toEqual(expect.objectContaining({
            eventId: expect.stringContaining(':bridge:pplns'),
            template: expect.objectContaining({
                payoutMode: 'pplns',
                payoutSnapshotId: 'seed-for-next-tip',
                payoutBridgeSeedCreatedAtMs: preparedAtMs,
                payoutOutputs: [
                    { address: 'bc1qseed-a', amountSats: 200_000_000 },
                    { address: 'bc1qseed-b', amountSats: 112_500_000 },
                ],
                transactions: [],
            }),
        }));
        expect(pplnsUpdate.template.notificationEventId).toBe(pplnsUpdate.eventId);
    });

    it('never falls back to PPLNS outputs when precomputation returns no outputs', async () => {
        const canonical = createTemplateAtHeight(840_000, '88');
        const payoutSnapshots = {
            createSnapshotForTemplate: jest.fn().mockResolvedValue({
                ...createSeedSnapshot(840_001, 312_500_000),
                payoutOutputs: [],
            }),
        };
        const redis = createRedisMock([]);
        const service = new BitcoinRpcService(
            createConfig({
                NETWORK: 'mainnet',
                SV1_SUBSIDY_BRIDGE_PAYOUT_MODES: 'pplns',
            }),
            {} as any,
            redis as any,
            payoutSnapshots as any,
        );
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        (service as any).storePplnsSubsidyBridgeSeed({
            candidateHeight: 840_001,
            subsidySats: 312_500_000,
            basisBits: canonical.bits,
            payoutSnapshotId: 'old-seed-that-must-not-fallback',
            payoutOutputs: [{ address: 'bc1qoldseed', amountSats: 312_500_000 }],
            preparedAtMs: Date.now(),
        });

        (service as any).queuePplnsSubsidyBridgeSeedPrecompute(canonical);
        await (service as any).pplnsSeedPrecomputeTail;

        expect((service as any).pplnsSubsidyBridgeSeeds.size).toBe(0);
        const nextTemplate = createTemplateAtHeight(840_001, '89');
        const trace = (service as any).startTrace('new_block');
        await expect((service as any).publishPplnsSubsidyBridge(
            nextTemplate,
            trace,
        )).resolves.toBe('skipped');
        expect(redis.publishSv1BridgeUpdate).not.toHaveBeenCalled();
        consoleSpy.mockRestore();
    });

    it('rejects mismatched or stale PPLNS seeds', async () => {
        const redis = createRedisMock([]);
        const template = createTemplateAtHeight(840_001, '99');
        const service = new BitcoinRpcService(
            createConfig({
                NETWORK: 'mainnet',
                SV1_SUBSIDY_BRIDGE_PAYOUT_MODES: 'pplns',
                SV1_SUBSIDY_BRIDGE_PPLNS_SEED_MAX_AGE_MS: '10',
            }),
            {} as any,
            redis as any,
        );
        const baseSeed = {
            subsidySats: calculateBlockSubsidySats(template.height, 'mainnet'),
            basisBits: template.bits,
            payoutSnapshotId: 'seed-stale',
            payoutOutputs: [{
                address: 'bc1qseed',
                amountSats: calculateBlockSubsidySats(template.height, 'mainnet'),
            }],
            preparedAtMs: Date.now(),
        };
        (service as any).storePplnsSubsidyBridgeSeed({
            ...baseSeed,
            candidateHeight: template.height + 1,
        });

        const trace = (service as any).startTrace('new_block');
        await expect((service as any).publishPplnsSubsidyBridge(
            template,
            trace,
        )).resolves.toBe('skipped');

        (service as any).storePplnsSubsidyBridgeSeed({
            ...baseSeed,
            candidateHeight: template.height,
            basisBits: '1d00ffff',
        });
        await expect((service as any).publishPplnsSubsidyBridge(
            template,
            trace,
        )).resolves.toBe('failed');

        (service as any).storePplnsSubsidyBridgeSeed({
            ...baseSeed,
            candidateHeight: template.height,
            preparedAtMs: Date.now() - 11,
        });
        await expect((service as any).publishPplnsSubsidyBridge(
            template,
            trace,
        )).resolves.toBe('skipped');
        expect(redis.publishSv1BridgeUpdate).not.toHaveBeenCalled();
    });

    it('keeps the solo bridge and full publication independent of PPLNS Redis failure', async () => {
        const order: string[] = [];
        const redis = createRedisMock(order);
        const template = createTemplateAtHeight(840_000, 'aa');
        redis.publishSv1BridgeUpdate.mockImplementation(async (update: any) => {
            order.push(`redis:publish:bridge:${update.template.payoutMode}`);
            if (update.template.payoutMode === 'pplns') {
                throw new Error('PPLNS Redis unavailable');
            }
            return true;
        });
        const service = new BitcoinRpcService(
            createConfig({
                NETWORK: 'mainnet',
                SV1_SUBSIDY_BRIDGE_PAYOUT_MODES: 'solo,pplns',
            }),
            { saveBlock: jest.fn().mockResolvedValue(undefined), getSavedBlockTemplate: jest.fn() } as any,
            redis as any,
            { createSnapshotForTemplate: jest.fn().mockResolvedValue(null) } as any,
        );
        (service as any).storePplnsSubsidyBridgeSeed({
            candidateHeight: template.height,
            subsidySats: 312_500_000,
            basisBits: template.bits,
            payoutSnapshotId: 'seed-redis-failure',
            payoutOutputs: [{ address: 'bc1qseed', amountSats: 312_500_000 }],
            preparedAtMs: Date.now(),
        });
        service.miningInfo = { blocks: template.height - 1 } as any;
        jest.spyOn(service as any, 'fetchBlockTemplate').mockResolvedValue(template);
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

        await service.getAndBroadcastLatestTemplate('new_block');

        expect(order).toEqual(expect.arrayContaining([
            'redis:publish:bridge:solo',
            'redis:publish:bridge:pplns',
            'redis:set:solo',
            'redis:publish:solo',
        ]));
        expect(order.indexOf('redis:publish:bridge:solo')).toBeLessThan(
            order.indexOf('redis:publish:bridge:pplns'),
        );
        expect(redis.setBlockTemplate).toHaveBeenCalledWith(
            template.height - 1,
            expect.objectContaining({ payoutMode: 'solo' }),
        );
        consoleSpy.mockRestore();
    });

    it('passes Core longpollid with a dedicated long timeout and remembers the returned id', async () => {
        const template = createTemplate();
        template.longpollid = 'next-longpoll-id';
        const post = jest.fn().mockResolvedValue({ data: { result: template, error: null } });
        const service = new BitcoinRpcService(
            {
                get: jest.fn((key: string) => key === 'BLOCK_TEMPLATE_LONGPOLL_TIMEOUT_MS' ? '123456' : undefined),
            } as unknown as ConfigService,
            {} as any,
            {} as any,
        );
        (service as any).client = { post };

        const trace = (service as any).startTrace('longpoll');
        const result = await (service as any).fetchBlockTemplate(trace, 'previous-longpoll-id');

        expect(result).toBe(template);
        expect(post).toHaveBeenCalledWith('', expect.objectContaining({
            method: 'getblocktemplate',
            params: [expect.objectContaining({ longpollid: 'previous-longpoll-id' })],
        }), { timeout: 123456 });
        expect((service as any).latestLongpollId).toBe('next-longpoll-id');
    });

    it('accepts the first authoritative template from an independent auxiliary longpoll source', async () => {
        const redis = createRedisMock([]);
        const template = createTemplateAtHeight(840_000, '73');
        template.longpollid = 'aux-next-longpoll';
        const auxiliaryClient = {
            post: jest.fn().mockResolvedValue({
                data: { result: template, error: null },
            }),
        };
        const source = {
            name: 'aux-1',
            client: auxiliaryClient,
            latestLongpollId: 'aux-prior-longpoll',
            longpollLoopStarted: true,
        };
        const service = new BitcoinRpcService(
            createConfig({ NETWORK: 'mainnet', BLOCK_TEMPLATE_LONGPOLL_TIMEOUT_MS: '1000' }),
            { saveBlock: jest.fn().mockResolvedValue(undefined), getSavedBlockTemplate: jest.fn() } as any,
            redis as any,
        );
        service.miningInfo = { blocks: template.height - 1 } as any;
        const primaryPost = jest.fn().mockResolvedValue({
            data: { result: template.previousblockhash, error: null },
        });
        (service as any).client = { post: primaryPost };
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

        await (service as any).getAndBroadcastLatestTemplateOnce(
            'longpoll',
            source.latestLongpollId,
            undefined,
            source,
        );

        expect(auxiliaryClient.post).toHaveBeenCalledWith('', expect.objectContaining({
            method: 'getblocktemplate',
            params: [expect.objectContaining({ longpollid: 'aux-prior-longpoll' })],
        }), { timeout: 1000 });
        expect(source.latestLongpollId).toBe('aux-next-longpoll');
        expect(primaryPost).toHaveBeenCalledWith('', expect.objectContaining({
            method: 'getbestblockhash',
        }), undefined);
        expect(redis.publishSv1BridgeUpdate).toHaveBeenCalled();
        expect(redis.setBlockTemplate).toHaveBeenCalledWith(
            template.height - 1,
            expect.objectContaining({ previousblockhash: template.previousblockhash }),
        );
        const sourceLog = logSpy.mock.calls
            .map(call => call[0])
            .find(value => typeof value === 'string' && value.includes('block_source_notification'));
        expect(JSON.parse(sourceLog)).toEqual(expect.objectContaining({
            source: 'longpoll',
            templateSource: 'aux-1',
        }));
        logSpy.mockRestore();
    });

    it('rejects auxiliary work before urgent and canonical publication when primary Core has another tip', async () => {
        const redis = createRedisMock([]);
        const template = createTemplateAtHeight(840_000, '74');
        const source = {
            name: 'aux-1',
            client: {
                post: jest.fn().mockResolvedValue({
                    data: { result: template, error: null },
                }),
            },
            latestLongpollId: 'aux-prior-longpoll',
            longpollLoopStarted: true,
        };
        const service = new BitcoinRpcService(
            createConfig({ NETWORK: 'mainnet' }),
            { saveBlock: jest.fn(), getSavedBlockTemplate: jest.fn() } as any,
            redis as any,
        );
        service.miningInfo = { blocks: template.height - 1 } as any;
        (service as any).client = {
            post: jest.fn().mockResolvedValue({
                data: { result: '75'.repeat(32), error: null },
            }),
        };
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        await (service as any).getAndBroadcastLatestTemplateOnce(
            'longpoll',
            source.latestLongpollId,
            undefined,
            source,
        );

        expect(redis.publishSv1BridgeUpdate).not.toHaveBeenCalled();
        expect(redis.setBlockTemplate).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('aux_template_rejected'));
        warnSpy.mockRestore();
    });

    it('deduplicates the same authoritative template returned by ZMQ and longpoll', async () => {
        const redis = createRedisMock([]);
        const template = createTemplate();
        const service = new BitcoinRpcService(
            {
                get: jest.fn((key: string) => key === 'SV1_SUBSIDY_BRIDGE_ENABLED' ? 'false' : undefined),
            } as unknown as ConfigService,
            { saveBlock: jest.fn().mockResolvedValue(undefined), getSavedBlockTemplate: jest.fn() } as any,
            redis as any,
            { createSnapshotForTemplate: jest.fn().mockResolvedValue(null) } as any,
        );
        service.miningInfo = { blocks: template.height - 1 } as any;
        jest.spyOn(service as any, 'fetchBlockTemplate').mockResolvedValue(template);

        await Promise.all([
            service.getAndBroadcastLatestTemplate('new_block'),
            service.getAndBroadcastLatestTemplate('longpoll', template.longpollid),
        ]);

        expect(redis.setBlockTemplate).toHaveBeenCalledTimes(1);
        expect(redis.publishBlockTemplateUpdate).toHaveBeenCalledTimes(1);
    });

    it('publishes templates whose ordered transaction body changes even when endpoint fields match', async () => {
        const redis = createRedisMock([]);
        const first = createTemplate();
        const changed = {
            ...first,
            transactions: first.transactions.map((transaction, index) => index === 0
                ? {
                    ...transaction,
                    // Keep count, endpoint txid, longpollid, and every prior
                    // signature field unchanged. The full body checksum must
                    // still distinguish this template.
                    data: `${transaction.data.startsWith('00') ? '01' : '00'}${transaction.data.slice(2)}`,
                }
                : { ...transaction }),
        };
        const service = new BitcoinRpcService(
            createConfig({ SV1_SUBSIDY_BRIDGE_ENABLED: 'false' }),
            { saveBlock: jest.fn().mockResolvedValue(undefined), getSavedBlockTemplate: jest.fn() } as any,
            redis as any,
            { createSnapshotForTemplate: jest.fn().mockResolvedValue(null) } as any,
        );
        service.miningInfo = { blocks: first.height - 1 } as any;
        jest.spyOn(service as any, 'fetchBlockTemplate')
            .mockResolvedValueOnce(first)
            .mockResolvedValueOnce(changed);

        await service.getAndBroadcastLatestTemplate('periodic');
        await service.getAndBroadcastLatestTemplate('periodic');

        expect(redis.setBlockTemplate).toHaveBeenCalledTimes(2);
        expect(redis.publishBlockTemplateUpdate).toHaveBeenCalledTimes(2);
    });

    it('does not let a stalled bridge publish block canonical template publication', async () => {
        const order: string[] = [];
        const redis = createRedisMock(order);
        let resolveBridge: () => void;
        const stalledBridge = new Promise<void>(resolve => { resolveBridge = resolve; });
        redis.publishSv1BridgeUpdate.mockImplementation((async (
            update: { template: IBlockTemplate },
            lane: 'fallback' | undefined,
        ) => {
            order.push(`redis:publish:bridge:${update.template.payoutMode}:${lane ?? 'urgent'}`);
            if (lane == null) {
                await stalledBridge;
            }
            return true;
        }) as any);
        const template = createTemplateAtHeight(840_000, '71');
        const service = new BitcoinRpcService(
            createConfig({ NETWORK: 'mainnet' }),
            { saveBlock: jest.fn().mockResolvedValue(undefined), getSavedBlockTemplate: jest.fn() } as any,
            redis as any,
            { createSnapshotForTemplate: jest.fn().mockResolvedValue(null) } as any,
        );
        service.miningInfo = { blocks: template.height - 1 } as any;
        jest.spyOn(service as any, 'fetchBlockTemplate').mockResolvedValue(template);

        await service.getAndBroadcastLatestTemplate('new_block');

        expect(redis.publishSv1BridgeUpdate).toHaveBeenCalledTimes(2);
        expect(redis.publishSv1BridgeUpdate).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ type: 'subsidy-bridge' }),
            'fallback',
        );
        expect(redis.setBlockTemplate).toHaveBeenCalledWith(
            template.height - 1,
            expect.objectContaining({ payoutMode: 'solo', jobType: 'full' }),
        );
        expect(redis.publishBlockTemplateUpdate).toHaveBeenCalledWith(expect.objectContaining({
            payoutMode: 'solo',
        }));
        expect(order.indexOf('redis:publish:bridge:solo:fallback')).toBeLessThan(order.indexOf('redis:set:solo'));

        resolveBridge!();
        await flushPromises();
    });

    it('retries the bridge from the canonical path after an immediate Redis delivery failure', async () => {
        const redis = createRedisMock([]);
        redis.publishSv1BridgeUpdate
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        const template = createTemplateAtHeight(840_000, '78');
        const service = new BitcoinRpcService(
            createConfig({ NETWORK: 'mainnet' }),
            { saveBlock: jest.fn().mockResolvedValue(undefined), getSavedBlockTemplate: jest.fn() } as any,
            redis as any,
            { createSnapshotForTemplate: jest.fn().mockResolvedValue(null) } as any,
        );
        service.miningInfo = { blocks: template.height - 1 } as any;
        jest.spyOn(service as any, 'fetchBlockTemplate').mockResolvedValue(template);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

        await service.getAndBroadcastLatestTemplate('new_block');

        expect(redis.publishSv1BridgeUpdate).toHaveBeenCalledTimes(2);
        expect(redis.setBlockTemplate).toHaveBeenCalledWith(
            template.height - 1,
            expect.objectContaining({ payoutMode: 'solo', jobType: 'full' }),
        );
        errorSpy.mockRestore();
    });

    it.each([
        ['mainnet', 'main'],
        ['testnet', 'test'],
        ['regtest', 'regtest'],
    ] as const)('accepts NETWORK=%s only for the matching Core chain', (network, chain) => {
        const service = new BitcoinRpcService(
            createConfig({ NETWORK: network }),
            {} as any,
            {} as any,
        );

        expect(() => (service as any).validateConfiguredNetworkAgainstCore(chain))
            .not.toThrow();
        expect(() => (service as any).validateConfiguredNetworkAgainstCore(
            chain === 'main' ? 'test' : 'main',
        )).toThrow(`NETWORK=${network} does not match Bitcoin Core chain=`);
    });

    it('publishes a durable next-height empty prestage after canonical work', async () => {
        const redis = createRedisMock([]);
        const template = createTemplateAtHeight(840_000, '72');
        const service = new BitcoinRpcService(
            createConfig({ NETWORK: 'mainnet' }),
            { saveBlock: jest.fn().mockResolvedValue(undefined), getSavedBlockTemplate: jest.fn() } as any,
            redis as any,
            { createSnapshotForTemplate: jest.fn().mockResolvedValue(null) } as any,
        );
        service.miningInfo = { blocks: template.height - 1 } as any;
        jest.spyOn(service as any, 'fetchBlockTemplate').mockResolvedValue(template);

        await service.getAndBroadcastLatestTemplate('new_block');
        await flushPromises();

        expect(redis.publishSv1PrestageUpdate).toHaveBeenCalledWith(expect.objectContaining({
            schemaVersion: 1,
            type: 'subsidy-prestage',
            template: expect.objectContaining({
                height: template.height + 1,
                previousblockhash: '0'.repeat(64),
                payoutMode: 'solo',
                jobType: 'empty',
                transactions: [],
                coinbasevalue: calculateBlockSubsidySats(template.height + 1, 'mainnet'),
            }),
        }));
    });

    it('verifies same-height reorgs against Core and never switches back to an orphan', async () => {
        const redis = createRedisMock([]);
        const first = createTemplateAtHeight(840_000, '31');
        const reorg = createTemplateAtHeight(840_000, '32');
        const service = new BitcoinRpcService(
            createConfig({ SV1_SUBSIDY_BRIDGE_ENABLED: 'false' }),
            { saveBlock: jest.fn().mockResolvedValue(undefined), getSavedBlockTemplate: jest.fn() } as any,
            redis as any,
            { createSnapshotForTemplate: jest.fn().mockResolvedValue(null) } as any,
        );
        service.miningInfo = { blocks: first.height - 1 } as any;
        jest.spyOn(service as any, 'fetchBlockTemplate')
            .mockResolvedValueOnce(first)
            .mockResolvedValueOnce(reorg)
            .mockResolvedValueOnce(first);
        const coreBestHash = jest.spyOn(service as any, 'callRpc')
            .mockResolvedValue(reorg.previousblockhash);

        await service.getAndBroadcastLatestTemplate('periodic');
        await service.getAndBroadcastLatestTemplate('new_block');
        await service.getAndBroadcastLatestTemplate('longpoll');

        expect(coreBestHash).toHaveBeenCalledTimes(2);
        expect(redis.setBlockTemplate).toHaveBeenCalledTimes(2);
        expect(redis.setBlockTemplate.mock.calls.at(-1)[1].previousblockhash)
            .toBe(reorg.previousblockhash);
    });

    it('accepts a Core-verified lower-height higher-work reorg and fences delayed old responses', async () => {
        const redis = createRedisMock([]);
        const original = createTemplateAtHeight(840_000, '51');
        const lowerReorg = createTemplateAtHeight(839_999, '52');
        const newBranch = createTemplateAtHeight(840_000, '53');
        const service = new BitcoinRpcService(
            createConfig({ SV1_SUBSIDY_BRIDGE_ENABLED: 'false' }),
            { saveBlock: jest.fn().mockResolvedValue(undefined), getSavedBlockTemplate: jest.fn() } as any,
            redis as any,
            { createSnapshotForTemplate: jest.fn().mockResolvedValue(null) } as any,
        );
        service.miningInfo = { blocks: original.height - 1 } as any;
        jest.spyOn(service as any, 'fetchBlockTemplate')
            .mockResolvedValueOnce(original)
            .mockResolvedValueOnce(lowerReorg)
            .mockResolvedValueOnce(newBranch)
            .mockResolvedValueOnce(original);
        const coreBestHash = jest.spyOn(service as any, 'callRpc')
            .mockResolvedValueOnce(lowerReorg.previousblockhash)
            .mockResolvedValueOnce(newBranch.previousblockhash)
            .mockResolvedValueOnce(newBranch.previousblockhash);

        await service.getAndBroadcastLatestTemplate('periodic');
        await service.getAndBroadcastLatestTemplate('new_block');
        await service.getAndBroadcastLatestTemplate('new_block');
        await service.getAndBroadcastLatestTemplate('longpoll');

        expect(coreBestHash).toHaveBeenCalledTimes(3);
        expect(redis.setBlockTemplate).toHaveBeenCalledTimes(3);
        expect(redis.setBlockTemplate.mock.calls.at(-1)[1].previousblockhash)
            .toBe(newBranch.previousblockhash);
    });

    it('single-flights periodic GBT refreshes during an outage or slow response', async () => {
        const redis = createRedisMock([]);
        const service = new BitcoinRpcService(
            createConfig({ SV1_SUBSIDY_BRIDGE_ENABLED: 'false' }),
            { saveBlock: jest.fn().mockResolvedValue(undefined), getSavedBlockTemplate: jest.fn() } as any,
            redis as any,
            { createSnapshotForTemplate: jest.fn().mockResolvedValue(null) } as any,
        );
        service.miningInfo = { blocks: createTemplate().height - 1 } as any;
        let resolveFetch: (template: IBlockTemplate) => void;
        const fetch = jest.spyOn(service as any, 'fetchBlockTemplate').mockReturnValue(
            new Promise<IBlockTemplate>(resolve => { resolveFetch = resolve; }),
        );

        const first = service.getAndBroadcastLatestTemplate('periodic');
        const second = service.getAndBroadcastLatestTemplate('periodic');
        expect(fetch).toHaveBeenCalledTimes(1);
        resolveFetch!(createTemplate());
        await Promise.all([first, second]);

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(redis.setBlockTemplate).toHaveBeenCalledTimes(1);
    });

    it('bounds detached persistence to the in-flight item plus the latest pending envelope', async () => {
        let resolveFirstSave: () => void;
        const saveBlock = jest.fn()
            .mockReturnValueOnce(new Promise<void>(resolve => { resolveFirstSave = resolve; }))
            .mockResolvedValue(undefined);
        const service = new BitcoinRpcService(
            createConfig({}),
            { saveBlock } as any,
            {} as any,
        );
        const trace = (service as any).startTrace('periodic');
        const first = { ...createTemplate(), notificationEventId: 'persist-first' };
        const middle = { ...createTemplate(), notificationEventId: 'persist-middle' };
        const latest = { ...createTemplate(), notificationEventId: 'persist-latest' };

        (service as any).queueTemplatePersistence(1, [first], trace);
        (service as any).queueTemplatePersistence(2, [middle], trace);
        (service as any).queueTemplatePersistence(3, [latest], trace);
        const drain = (service as any).persistenceDrainPromise;
        expect(saveBlock).toHaveBeenCalledTimes(1);
        resolveFirstSave!();
        await drain;

        expect(saveBlock).toHaveBeenCalledTimes(2);
        expect(saveBlock.mock.calls[1][0]).toBe(3);
        expect(JSON.parse(saveBlock.mock.calls[1][1]).templates[0].notificationEventId)
            .toBe('persist-latest');
    });

    it('ignores stale bridge replays but lets newer canonical work override a conflicting bridge', async () => {
        const service = new BitcoinRpcService(
            createConfig({}),
            {} as any,
            {} as any,
        );
        service.miningInfo = { blocks: 900_000 } as any;
        const bridges: IBlockTemplate[] = [];
        const canonicals: IBlockTemplate[] = [];
        service.newSv1BridgeTemplate$.subscribe(template => bridges.push(template));
        service.newBlockTemplate$.subscribe(template => canonicals.push(template));
        const bridgeTemplate = {
            ...createTemplate(),
            height: 900_001,
            previousblockhash: '41'.repeat(32),
            payoutMode: 'solo' as const,
            jobType: 'empty' as const,
            transactions: [],
        };

        await (service as any).handleSv1BridgeUpdate({
            schemaVersion: 1,
            type: 'subsidy-bridge',
            eventId: 'stale-height',
            publishedAtMs: 100,
            template: { ...bridgeTemplate, height: 899_999 },
        });
        await (service as any).handleSv1BridgeUpdate({
            schemaVersion: 1,
            type: 'subsidy-bridge',
            eventId: 'fresh-bridge',
            publishedAtMs: 200,
            template: bridgeTemplate,
        });

        const canonical = {
            ...createTemplate(),
            height: bridgeTemplate.height,
            previousblockhash: '42'.repeat(32),
            payoutMode: 'solo' as const,
            jobType: 'full' as const,
            notificationEventId: 'canonical-newer',
            notificationPublishedAtMs: 300,
        };
        (service as any).emitCanonicalTemplate(canonical);
        (service as any).emitCanonicalTemplate(canonical);
        (service as any).emitCanonicalTemplate({
            ...canonical,
            previousblockhash: '43'.repeat(32),
            notificationEventId: 'canonical-older',
            notificationPublishedAtMs: 250,
        });

        expect(bridges).toEqual([expect.objectContaining({ previousblockhash: bridgeTemplate.previousblockhash })]);
        expect(canonicals).toEqual([expect.objectContaining({ previousblockhash: canonical.previousblockhash })]);
    });

    it('rejects live bridge updates older than or redundant with active canonical work', async () => {
        const service = new BitcoinRpcService(
            createConfig({}),
            {} as any,
            {} as any,
        );
        service.miningInfo = { blocks: 900_000 } as any;
        const bridges: IBlockTemplate[] = [];
        service.newSv1BridgeTemplate$.subscribe(template => bridges.push(template));
        const canonical = {
            ...createTemplate(),
            height: 900_001,
            previousblockhash: '71'.repeat(32),
            payoutMode: 'solo' as const,
            jobType: 'full' as const,
            notificationEventId: 'canonical-active',
            notificationPublishedAtMs: 300,
        };
        (service as any).emitCanonicalTemplate(canonical);

        const sendBridge = (eventId: string, previousblockhash: string, publishedAtMs: number) => (
            (service as any).handleSv1BridgeUpdate({
                schemaVersion: 1,
                type: 'subsidy-bridge',
                eventId,
                publishedAtMs,
                template: {
                    ...canonical,
                    previousblockhash,
                    payoutMode: 'solo',
                    jobType: 'empty',
                    transactions: [],
                },
            })
        );
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        await sendBridge('redundant-same-tip', canonical.previousblockhash, 400);
        await sendBridge('older-conflicting-tip', '72'.repeat(32), 300);
        await sendBridge('newer-conflicting-tip', '73'.repeat(32), 301);

        (service as any).emitCanonicalTemplate({
            ...canonical,
            previousblockhash: '74'.repeat(32),
            notificationEventId: 'legacy-canonical-without-time',
            notificationPublishedAtMs: undefined,
        });
        await sendBridge('unproven-after-legacy-canonical', '75'.repeat(32), 999);

        expect(bridges).toEqual([
            expect.objectContaining({ previousblockhash: '73'.repeat(32) }),
        ]);
        warnSpy.mockRestore();
    });

    it('loads the legacy height key when an old master publishes only mining-info updates', async () => {
        const previousMaster = process.env.MASTER;
        const previousApiOnly = process.env.API_ONLY;
        process.env.MASTER = 'false';
        process.env.API_ONLY = 'false';
        let miningInfoHandler: (miningInfo: any) => Promise<void>;
        const redis = {
            getLatestMiningInfo: jest.fn().mockResolvedValue({ blocks: 10 }),
            subscribeSv1BridgeUpdates: jest.fn().mockResolvedValue(undefined),
            subscribeBlockTemplateUpdates: jest.fn().mockResolvedValue(undefined),
            getLatestSv1BridgeUpdate: jest.fn().mockResolvedValue(null),
            getBlockTemplate: jest.fn().mockResolvedValue(null),
            getLatestBlockTemplates: jest.fn().mockResolvedValue([]),
            subscribeMiningInfoUpdates: jest.fn(async (handler: typeof miningInfoHandler) => {
                miningInfoHandler = handler;
            }),
        };
        const service = new BitcoinRpcService(
            createConfig({}),
            { getSavedBlockTemplate: jest.fn().mockResolvedValue(null) } as any,
            redis as any,
        );

        try {
            await service.onModuleInit();
            expect(redis.subscribeMiningInfoUpdates.mock.invocationCallOrder[0])
                .toBeLessThan(redis.getBlockTemplate.mock.invocationCallOrder[0]);
            await miningInfoHandler!({ blocks: 11 });

            expect(redis.getBlockTemplate).toHaveBeenLastCalledWith(11, 'solo', undefined);
            expect(redis.getLatestSv1BridgeUpdate).not.toHaveBeenCalled();
        } finally {
            if (previousMaster == null) delete process.env.MASTER;
            else process.env.MASTER = previousMaster;
            if (previousApiOnly == null) delete process.env.API_ONLY;
            else process.env.API_ONLY = previousApiOnly;
        }
    });

    it('replays a newer solo latest pointer before stale mining-info fallback and rejects a later lower legacy replay', async () => {
        const previousMaster = process.env.MASTER;
        const previousApiOnly = process.env.API_ONLY;
        process.env.MASTER = 'false';
        process.env.API_ONLY = 'false';
        const latestSolo = {
            ...createTemplate(),
            payoutMode: 'solo' as const,
            notificationEventId: 'new-solo-pointer',
            notificationPublishedAtMs: 200,
        };
        const staleTipHeight = latestSolo.height - 2;
        const staleLegacy = {
            ...latestSolo,
            height: latestSolo.height - 1,
            previousblockhash: '76'.repeat(32),
            payoutMode: undefined,
            notificationEventId: undefined,
            notificationPublishedAtMs: undefined,
        };
        let miningInfoHandler: (miningInfo: any) => Promise<void>;
        const getBlockTemplate = jest.fn().mockResolvedValue(null);
        const redis = {
            getLatestMiningInfo: jest.fn().mockResolvedValue({ blocks: staleTipHeight }),
            getLatestBlockTemplates: jest.fn().mockResolvedValue([latestSolo]),
            subscribeSv1BridgeUpdates: jest.fn().mockResolvedValue(undefined),
            subscribeBlockTemplateUpdates: jest.fn().mockResolvedValue(undefined),
            subscribeMiningInfoUpdates: jest.fn(async (handler: typeof miningInfoHandler) => {
                miningInfoHandler = handler;
            }),
            getBlockTemplate,
        };
        const service = new BitcoinRpcService(
            createConfig({}),
            { getSavedBlockTemplate: jest.fn().mockResolvedValue(null) } as any,
            redis as any,
        );
        const emitted: IBlockTemplate[] = [];
        const subscription = service.newBlockTemplate$.subscribe(template => emitted.push(template));
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        try {
            await service.onModuleInit();

            expect(redis.subscribeSv1BridgeUpdates.mock.invocationCallOrder[0])
                .toBeLessThan(redis.getLatestBlockTemplates.mock.invocationCallOrder[0]);
            expect(redis.subscribeBlockTemplateUpdates.mock.invocationCallOrder[0])
                .toBeLessThan(redis.getLatestBlockTemplates.mock.invocationCallOrder[0]);
            expect(redis.subscribeMiningInfoUpdates.mock.invocationCallOrder[0])
                .toBeLessThan(redis.getLatestBlockTemplates.mock.invocationCallOrder[0]);
            expect(getBlockTemplate).toHaveBeenCalledWith(staleTipHeight, 'pplns', undefined);
            expect(getBlockTemplate).not.toHaveBeenCalledWith(staleTipHeight, 'solo', undefined);
            expect(emitted).toEqual([
                expect.objectContaining({
                    payoutMode: 'solo',
                    height: latestSolo.height,
                    notificationEventId: 'new-solo-pointer',
                }),
            ]);

            getBlockTemplate.mockResolvedValue(staleLegacy);
            await miningInfoHandler!({ blocks: staleTipHeight });

            expect(emitted).toHaveLength(1);
            expect(emitted[0].height).toBe(latestSolo.height);
        } finally {
            subscription.unsubscribe();
            warnSpy.mockRestore();
            if (previousMaster == null) delete process.env.MASTER;
            else process.env.MASTER = previousMaster;
            if (previousApiOnly == null) delete process.env.API_ONLY;
            else process.env.API_ONLY = previousApiOnly;
        }
    });

    it('prefers a newer timestamped lower-height pointer after a rollback over stale higher mining info', async () => {
        const rollbackPointer = {
            ...createTemplate(),
            payoutMode: 'solo' as const,
            height: createTemplate().height - 1,
            previousblockhash: '77'.repeat(32),
            notificationEventId: 'verified-lower-reorg',
            notificationPublishedAtMs: 300,
        };
        const staleLegacy = {
            ...createTemplate(),
            payoutMode: 'solo' as const,
            notificationEventId: 'stale-higher-legacy',
            notificationPublishedAtMs: 200,
        };
        const redis = {
            getLatestMiningInfo: jest.fn().mockResolvedValue({ blocks: rollbackPointer.height }),
            getLatestBlockTemplates: jest.fn().mockResolvedValue([rollbackPointer]),
            getBlockTemplate: jest.fn(async (_height: number, payoutMode: 'solo' | 'pplns') => (
                payoutMode === 'solo' ? staleLegacy : null
            )),
        };
        const service = new BitcoinRpcService(
            createConfig({}),
            { getSavedBlockTemplate: jest.fn().mockResolvedValue(null) } as any,
            redis as any,
        );
        const emitted: IBlockTemplate[] = [];
        const subscription = service.newBlockTemplate$.subscribe(template => emitted.push(template));

        try {
            await (service as any).loadLatestTemplateForWorker();

            expect(redis.getBlockTemplate).toHaveBeenCalledWith(
                rollbackPointer.height,
                'solo',
                undefined,
            );
            expect(emitted).toEqual([
                expect.objectContaining({
                    height: rollbackPointer.height,
                    previousblockhash: rollbackPointer.previousblockhash,
                    notificationEventId: 'verified-lower-reorg',
                }),
            ]);
        } finally {
            subscription.unsubscribe();
        }
    });

    it('re-arms the Core longpoll with the id returned by the prior request', async () => {
        const previousMaster = process.env.MASTER;
        process.env.MASTER = 'true';
        try {
            const service = new BitcoinRpcService(
                { get: jest.fn() } as unknown as ConfigService,
                {} as any,
                {} as any,
            );
            (service as any).latestLongpollId = 'lp-1';
            const calls: string[] = [];
            jest.spyOn(service, 'getAndBroadcastLatestTemplate').mockImplementation(async (_reason, longpollId) => {
                calls.push(longpollId!);
                if (calls.length === 1) {
                    (service as any).latestLongpollId = 'lp-2';
                } else {
                    process.env.MASTER = 'false';
                }
            });

            await (service as any).listenForLongpollTemplates();

            expect(calls).toEqual(['lp-1', 'lp-2']);
        } finally {
            if (previousMaster == null) {
                delete process.env.MASTER;
            } else {
                process.env.MASTER = previousMaster;
            }
        }
    });

    it('exposes BIP23 proposal validation for reconstructed bridge/full blocks', async () => {
        const post = jest.fn().mockResolvedValue({ data: { result: null, error: null } });
        const service = new BitcoinRpcService(
            { get: jest.fn() } as unknown as ConfigService,
            {} as any,
            {} as any,
        );
        (service as any).client = { post };

        await expect(service.TEST_BLOCK_PROPOSAL('00ff')).resolves.toBeNull();
        expect(post).toHaveBeenCalledWith('', expect.objectContaining({
            method: 'getblocktemplate',
            params: [{ mode: 'proposal', data: '00ff', rules: ['segwit'] }],
        }), undefined);
    });

    it('returns success only when Core confirms an accepted submitted block is active', async () => {
        const service = new BitcoinRpcService(
            createConfig({}),
            {} as any,
            {} as any,
        );
        const callRpc = jest.spyOn(service as any, 'callRpc')
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ confirmations: 1 });
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

        try {
            await expect(service.SUBMIT_BLOCK(GENESIS_HEADER_HEX)).resolves.toBe('SUCCESS!');
            expect(callRpc).toHaveBeenNthCalledWith(1, 'submitblock', [GENESIS_HEADER_HEX]);
            expect(callRpc).toHaveBeenNthCalledWith(2, 'getblockheader', [GENESIS_BLOCK_HASH, true]);
        } finally {
            logSpy.mockRestore();
        }
    });

    it('does not treat an accepted side-chain block as a successful submission', async () => {
        const service = new BitcoinRpcService(
            createConfig({}),
            {} as any,
            {} as any,
        );
        jest.spyOn(service as any, 'callRpc')
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ confirmations: -1 });
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

        try {
            await expect(service.SUBMIT_BLOCK(GENESIS_HEADER_HEX))
                .resolves.toBe('ACCEPTED_BLOCK_NOT_ACTIVE_CHAIN: confirmations=-1');
        } finally {
            logSpy.mockRestore();
        }
    });

    it('fails closed when active-chain verification after submitblock cannot complete', async () => {
        const service = new BitcoinRpcService(
            createConfig({}),
            {} as any,
            {} as any,
        );
        jest.spyOn(service as any, 'callRpc')
            .mockResolvedValueOnce(null)
            .mockRejectedValueOnce(new Error('header lookup failed'));
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

        try {
            await expect(service.SUBMIT_BLOCK(GENESIS_HEADER_HEX))
                .resolves.toBe('ACTIVE_CHAIN_VERIFICATION_FAILED: header lookup failed');
        } finally {
            logSpy.mockRestore();
        }
    });

    it('preserves non-null submitblock rejection strings without active-chain lookup', async () => {
        const service = new BitcoinRpcService(
            createConfig({}),
            {} as any,
            {} as any,
        );
        const callRpc = jest.spyOn(service as any, 'callRpc').mockResolvedValueOnce('stale-prevblk');
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

        try {
            await expect(service.SUBMIT_BLOCK(GENESIS_HEADER_HEX)).resolves.toBe('stale-prevblk');
            expect(callRpc).toHaveBeenCalledTimes(1);
        } finally {
            logSpy.mockRestore();
        }
    });
});

const GENESIS_HEADER_HEX = [
    '01000000',
    '00'.repeat(32),
    '3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a',
    '29ab5f49',
    'ffff001d',
    '1dac2b7c',
].join('');
const GENESIS_BLOCK_HASH = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';

function createRedisMock(order: string[]) {
    return {
        setBlockTemplate: jest.fn(async (_height: number, template: IBlockTemplate) => {
            order.push(`redis:set:${template.payoutMode}`);
            return 'key';
        }),
        setLatestMiningInfo: jest.fn().mockResolvedValue(undefined),
        publishMiningInfoUpdate: jest.fn(async () => {
            order.push('redis:publish:mining-info');
        }),
        publishBlockTemplateUpdate: jest.fn(async (update: { payoutMode: string }) => {
            order.push(`redis:publish:${update.payoutMode}`);
        }),
        publishSv1BridgeUpdate: jest.fn(async (update: { template: IBlockTemplate }) => {
            order.push(`redis:publish:bridge:${update.template.payoutMode}`);
            return true;
        }),
        publishSv1PrestageUpdate: jest.fn(async (update: { template: IBlockTemplate }) => {
            order.push(`redis:publish:prestage:${update.template.payoutMode}`);
        }),
        setLegacyBlockTemplate: jest.fn(async (_height: number, template: IBlockTemplate) => {
            order.push(`redis:set:legacy:${template.payoutMode}`);
        }),
    };
}

function createConfig(values: Record<string, string>): ConfigService {
    return {
        get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
}

function createTemplateAtHeight(height: number, previousHashByte: string): IBlockTemplate {
    const template = createBaseTemplate();
    template.height = height;
    template.previousblockhash = previousHashByte.repeat(32);
    template.longpollid = `${template.previousblockhash}:${height}`;
    template.curtime += height - MockRecording1.BLOCK_TEMPLATE.height;
    const fees = template.transactions.reduce((sum, transaction) => sum + transaction.fee, 0);
    template.coinbasevalue = calculateBlockSubsidySats(height, 'mainnet') + fees;
    return template;
}

function createBaseTemplate(): IBlockTemplate {
    return {
        ...MockRecording1.BLOCK_TEMPLATE,
        transactions: MockRecording1.BLOCK_TEMPLATE.transactions.map(tx => ({ ...tx })),
    };
}

function createSeedSnapshot(height: number, subsidySats: number) {
    return {
        id: `seed-${height}`,
        blockHeight: height,
        coinbaseValueSats: subsidySats.toString(),
        payoutMode: 'pplns',
        payoutOutputs: [{ address: 'bc1qseed', amountSats: subsidySats }],
    };
}

async function flushPromises(): Promise<void> {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
}
