import * as bitcoinjs from 'bitcoinjs-lib';
import { BehaviorSubject, firstValueFrom, skip, Subject } from 'rxjs';

import { MockRecording1 } from '../../test/models/MockRecording1';
import { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { createPreparedMiningJob } from './prepared-mining-job.factory';
import { StratumV1JobsService } from './stratum-v1-jobs.service';

describe('StratumV1JobsService', () => {
    let blockTemplate$: BehaviorSubject<IBlockTemplate>;
    let bridgeTemplate$: Subject<IBlockTemplate>;
    let bitcoinRpcService: { newBlockTemplate$: any, newSv1BridgeTemplate$: any, miningInfo: { blocks: number } };
    let service: StratumV1JobsService;
    let consoleLogSpy: jest.SpyInstance;

    const createTemplate = (height = MockRecording1.BLOCK_TEMPLATE.height): IBlockTemplate => ({
        ...MockRecording1.BLOCK_TEMPLATE,
        transactions: MockRecording1.BLOCK_TEMPLATE.transactions.map(tx => ({ ...tx })),
        height
    });

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(parseInt(MockRecording1.TIME, 16) * 1000));
        consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

        blockTemplate$ = new BehaviorSubject(createTemplate());
        bridgeTemplate$ = new Subject<IBlockTemplate>();
        bitcoinRpcService = {
            newBlockTemplate$: blockTemplate$.asObservable(),
            newSv1BridgeTemplate$: bridgeTemplate$.asObservable(),
            miningInfo: { blocks: MockRecording1.BLOCK_TEMPLATE.height }
        };
        service = new StratumV1JobsService(bitcoinRpcService as any);
    });

    afterEach(() => {
        consoleLogSpy.mockRestore();
        jest.useRealTimers();
    });

    it('should create job templates from block templates', async () => {
        const jobTemplate = await firstValueFrom(service.newMiningJob$);
        const sourceTemplate = createTemplate();
        const prepared = createPreparedMiningJob(sourceTemplate);

        expect(jobTemplate.blockData).toEqual(expect.objectContaining({
            id: '1',
            height: MockRecording1.BLOCK_TEMPLATE.height,
            clearJobs: true,
            coinbasevalue: MockRecording1.BLOCK_TEMPLATE.coinbasevalue,
            transactions: sourceTemplate.transactions,
            bodyReference: prepared.body,
        }));
        expect(jobTemplate.block.transactions).toHaveLength(1);
        expect(jobTemplate.merkle_branch).toEqual(prepared.coinbase.merkleBranch);
        expect(jobTemplate.block.witnessCommit.toString('hex'))
            .toBe(prepared.coinbase.witnessCommitmentHash);
        expect(jobTemplate.block.transactions[0].ins[0].witness[0]).toHaveLength(32);
        expect(service.getJobTemplateById('1')).toBe(jobTemplate);
    });

    it('does not parse transaction bodies while preparing a mining job', async () => {
        const fromHexSpy = jest.spyOn(bitcoinjs.Transaction, 'fromHex');
        const reorderedTemplate = createTemplate();
        reorderedTemplate.transactions = reorderedTemplate.transactions.slice().reverse();

        const nextTemplate = firstValueFrom(service.newMiningJob$.pipe(skip(1)));
        blockTemplate$.next(reorderedTemplate);
        const jobTemplate = await nextTemplate;

        expect(fromHexSpy).not.toHaveBeenCalled();
        expect(jobTemplate.block.transactions).toHaveLength(1);
        expect(jobTemplate.blockData.transactions).toHaveLength(reorderedTemplate.transactions.length);
        expect(jobTemplate.merkle_branch)
            .toEqual(createPreparedMiningJob(reorderedTemplate).coinbase.merkleBranch);
    });

    it('should mark a new previous block hash clean while retaining old jobs for late submissions', async () => {
        const firstTemplate = await firstValueFrom(service.newMiningJob$);
        service.addJob({ jobId: 'old-job', creation: Date.now() } as any);

        const changedTipTemplate = createTemplate(MockRecording1.BLOCK_TEMPLATE.height + 1);
        changedTipTemplate.previousblockhash = '11'.repeat(32);
        const nextTemplate = firstValueFrom(service.newMiningJob$.pipe(skip(1)));
        blockTemplate$.next(changedTipTemplate);
        const jobTemplate = await nextTemplate;

        expect(jobTemplate.blockData.clearJobs).toBe(true);
        expect(jobTemplate.blockData.isNewBlock).toBe(true);
        expect(service.getJobById('old-job')).toBeDefined();
        expect(service.getJobTemplateById(firstTemplate.blockData.id)).toBe(firstTemplate);
        expect(service.getJobTemplateById(jobTemplate.blockData.id)).toBe(jobTemplate);
    });

    it('should force a clean miner switch without treating the same tip as a new block', async () => {
        await firstValueFrom(service.newMiningJob$);
        service.addJob({ jobId: 'bridge-job', creation: Date.now() } as any);
        const fullTemplate = createTemplate();
        fullTemplate.forceCleanJobs = true;
        fullTemplate.transactions = fullTemplate.transactions.slice(0, -1);

        const nextTemplate = firstValueFrom(service.newMiningJob$.pipe(skip(1)));
        blockTemplate$.next(fullTemplate);
        const jobTemplate = await nextTemplate;

        expect(jobTemplate.blockData.clearJobs).toBe(true);
        expect(jobTemplate.blockData.isNewBlock).toBe(false);
        expect(service.getJobById('bridge-job')).toBeDefined();
    });

    it('emits the subsidy bridge only on the ordered SV1 stream, followed by canonical full work', async () => {
        await firstValueFrom(service.newMiningJob$);
        const bridgeSource = createTemplate(MockRecording1.BLOCK_TEMPLATE.height + 1);
        bridgeSource.previousblockhash = '12'.repeat(32);
        bridgeSource.transactions = [];
        bridgeSource.jobType = 'empty';
        bridgeSource.payoutMode = 'solo';
        bridgeSource.forceCleanJobs = true;

        const bridgeResult = firstValueFrom(service.sv1MiningJob$.pipe(skip(1)));
        bridgeTemplate$.next(bridgeSource);
        const bridge = await bridgeResult;

        expect(bridge.blockData.jobType).toBe('empty');
        expect(bridge.blockData.clearJobs).toBe(true);
        expect(bridge.merkle_branch).toEqual([]);

        const fullSource = createTemplate(bridgeSource.height);
        fullSource.previousblockhash = bridgeSource.previousblockhash;
        fullSource.payoutMode = 'solo';
        fullSource.forceCleanJobs = true;
        const fullResult = firstValueFrom(service.sv1MiningJob$.pipe(skip(1)));
        blockTemplate$.next(fullSource);
        const full = await fullResult;

        expect(full.blockData.jobType).toBe('full');
        expect(full.blockData.isNewBlock).toBe(false);
        expect(full.blockData.clearJobs).toBe(true);
        expect(full.blockData.tipKey).toBe(bridge.blockData.tipKey);
        expect(full.merkle_branch.length).toBeGreaterThan(0);
    });

    it('should keep same-tip bridge and full jobs current, then mark both stale on the next tip', async () => {
        const bridgeTemplate = await firstValueFrom(service.newMiningJob$);
        const payout = [{ address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', percent: 100 }];
        const bridgeJob = service.getOrCreateJob(bitcoinjs.networks.testnet, payout, bridgeTemplate);

        const fullSource = createTemplate();
        fullSource.forceCleanJobs = true;
        fullSource.transactions = fullSource.transactions.slice(0, -1);
        const fullResult = firstValueFrom(service.newMiningJob$.pipe(skip(1)));
        blockTemplate$.next(fullSource);
        const fullTemplate = await fullResult;
        const fullJob = service.getOrCreateJob(bitcoinjs.networks.testnet, payout, fullTemplate);

        expect(bridgeJob.tipKey).toBe(fullJob.tipKey);
        expect(service.getSubmissionContext(bridgeJob.jobId)?.status).toBe('current');
        expect(service.getSubmissionContext(fullJob.jobId)?.status).toBe('current');

        const nextTipSource = createTemplate(MockRecording1.BLOCK_TEMPLATE.height + 1);
        nextTipSource.previousblockhash = '22'.repeat(32);
        const nextTipResult = firstValueFrom(service.newMiningJob$.pipe(skip(1)));
        blockTemplate$.next(nextTipSource);
        const nextTipTemplate = await nextTipResult;
        const nextTipJob = service.getOrCreateJob(bitcoinjs.networks.testnet, payout, nextTipTemplate);

        expect(service.getSubmissionContext(bridgeJob.jobId)?.status).toBe('stale');
        expect(service.getSubmissionContext(fullJob.jobId)?.status).toBe('stale');
        expect(service.getSubmissionContext(nextTipJob.jobId)?.status).toBe('current');
    });

    it('keeps a new solo tip independent from delayed old-tip PPLNS work and pinning', async () => {
        const previousRetention = process.env.STRATUM_JOB_RETENTION_MS;
        process.env.STRATUM_JOB_RETENTION_MS = '1000';
        try {
            const sharedTemplate = await firstValueFrom(service.newMiningJob$);
            const payout = [{ address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', percent: 100 }];
            const oldSoloJob = service.getOrCreateJob(
                bitcoinjs.networks.testnet,
                payout,
                sharedTemplate,
                'solo-old-tip',
                'solo',
            );
            const oldPplnsJob = service.getOrCreateJob(
                bitcoinjs.networks.testnet,
                payout,
                sharedTemplate,
                'pplns-old-tip',
                'pplns',
            );

            const newSoloSource = createTemplate(MockRecording1.BLOCK_TEMPLATE.height + 1);
            newSoloSource.previousblockhash = '44'.repeat(32);
            newSoloSource.payoutMode = 'solo';
            const newSoloResult = firstValueFrom(service.newMiningJob$.pipe(skip(1)));
            blockTemplate$.next(newSoloSource);
            const newSoloTemplate = await newSoloResult;
            const newSoloJob = service.getOrCreateJob(
                bitcoinjs.networks.testnet,
                payout,
                newSoloTemplate,
                'solo-new-tip',
                'solo',
            );

            expect(service.getSubmissionContext(oldSoloJob.jobId)?.status).toBe('stale');
            expect(service.getSubmissionContext(oldPplnsJob.jobId)?.status).toBe('current');
            expect(service.getSubmissionContext(newSoloJob.jobId)?.status).toBe('current');

            sharedTemplate.blockData.creation = Date.now() - 1001;
            oldSoloJob.creation = Date.now() - 1001;
            oldPplnsJob.creation = Date.now() - 1001;
            const delayedPplnsSource = createTemplate();
            delayedPplnsSource.payoutMode = 'pplns';
            delayedPplnsSource.payoutSnapshotId = 'delayed-old-tip';
            delayedPplnsSource.payoutOutputs = [{
                address: payout[0].address,
                amountSats: delayedPplnsSource.coinbasevalue,
            }];
            const delayedPplnsResult = firstValueFrom(service.newMiningJob$.pipe(skip(1)));
            blockTemplate$.next(delayedPplnsSource);
            const delayedPplnsTemplate = await delayedPplnsResult;
            const delayedPplnsJob = service.getOrCreateJob(
                bitcoinjs.networks.testnet,
                delayedPplnsSource.payoutOutputs,
                delayedPplnsTemplate,
                'pplns-delayed-old-tip',
                'pplns',
            );

            expect(delayedPplnsTemplate.blockData.isNewBlock).toBe(false);
            expect(delayedPplnsTemplate.blockData.clearJobs).toBe(false);
            expect(service.getJobById(oldSoloJob.jobId)).toBeUndefined();
            expect(service.getSubmissionContext(oldPplnsJob.jobId)?.status).toBe('current');
            expect(service.getSubmissionContext(delayedPplnsJob.jobId)?.status).toBe('current');
            expect(service.getSubmissionContext(newSoloJob.jobId)?.status).toBe('current');
            expect(service.getJobTemplateById(sharedTemplate.blockData.id)).toBe(sharedTemplate);

            delayedPplnsTemplate.blockData.creation = Date.now() - 1001;
            delayedPplnsJob.creation = Date.now() - 1001;
            const alignedPplnsSource = createTemplate(newSoloSource.height);
            alignedPplnsSource.previousblockhash = newSoloSource.previousblockhash;
            alignedPplnsSource.payoutMode = 'pplns';
            alignedPplnsSource.payoutSnapshotId = 'aligned-new-tip';
            alignedPplnsSource.payoutOutputs = [{
                address: payout[0].address,
                amountSats: alignedPplnsSource.coinbasevalue,
            }];
            const alignedPplnsResult = firstValueFrom(service.newMiningJob$.pipe(skip(1)));
            blockTemplate$.next(alignedPplnsSource);
            const alignedPplnsTemplate = await alignedPplnsResult;
            const alignedPplnsJob = service.getOrCreateJob(
                bitcoinjs.networks.testnet,
                alignedPplnsSource.payoutOutputs,
                alignedPplnsTemplate,
                'pplns-aligned-new-tip',
                'pplns',
            );

            expect(alignedPplnsTemplate.blockData.isNewBlock).toBe(true);
            expect(service.getJobById(oldPplnsJob.jobId)).toBeUndefined();
            expect(service.getJobById(delayedPplnsJob.jobId)).toBeUndefined();
            expect(service.getJobTemplateById(sharedTemplate.blockData.id)).toBeUndefined();
            expect(service.getJobTemplateById(delayedPplnsTemplate.blockData.id)).toBeUndefined();
            expect(service.getSubmissionContext(newSoloJob.jobId)?.status).toBe('current');
            expect(service.getSubmissionContext(alignedPplnsJob.jobId)?.status).toBe('current');
        } finally {
            if (previousRetention == null) {
                delete process.env.STRATUM_JOB_RETENTION_MS;
            } else {
                process.env.STRATUM_JOB_RETENTION_MS = previousRetention;
            }
        }
    });

    it('classifies concurrent startup replays independently in either mode order', async () => {
        const payout = [{ address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', percent: 100 }];
        const soloSource = createTemplate(MockRecording1.BLOCK_TEMPLATE.height + 1);
        soloSource.previousblockhash = '55'.repeat(32);
        soloSource.payoutMode = 'solo';
        soloSource.forceCleanJobs = true;
        const pplnsSource = createTemplate();
        pplnsSource.payoutMode = 'pplns';
        pplnsSource.forceCleanJobs = true;
        pplnsSource.payoutSnapshotId = 'startup-pplns';
        pplnsSource.payoutOutputs = [{
            address: payout[0].address,
            amountSats: pplnsSource.coinbasevalue,
        }];
        const sources = { solo: soloSource, pplns: pplnsSource };

        for (const canonicalMode of ['solo', 'pplns'] as const) {
            const bridgeMode = canonicalMode === 'solo' ? 'pplns' : 'solo';
            const canonical$ = new BehaviorSubject(sources[canonicalMode]);
            const bridge$ = new BehaviorSubject(sources[bridgeMode]);
            const startupService = new StratumV1JobsService({
                newBlockTemplate$: canonical$.asObservable(),
                newSv1BridgeTemplate$: bridge$.asObservable(),
                miningInfo: { blocks: MockRecording1.BLOCK_TEMPLATE.height },
            } as any);
            await firstValueFrom(startupService.sv1MiningJob$);

            const soloTemplate = startupService.getLatestJobTemplate('solo');
            const pplnsTemplate = startupService.getLatestJobTemplate('pplns');
            const soloJob = startupService.getOrCreateJob(
                bitcoinjs.networks.testnet,
                payout,
                soloTemplate,
                `startup-solo-${canonicalMode}`,
                'solo',
            );
            const pplnsJob = startupService.getOrCreateJob(
                bitcoinjs.networks.testnet,
                pplnsSource.payoutOutputs,
                pplnsTemplate,
                `startup-pplns-${canonicalMode}`,
                'pplns',
            );

            expect(startupService.getSubmissionContext(soloJob.jobId)?.status).toBe('current');
            expect(startupService.getSubmissionContext(pplnsJob.jobId)?.status).toBe('current');
        }
    });

    it('should skip identical non-clean template refreshes', async () => {
        await firstValueFrom(service.newMiningJob$);

        blockTemplate$.next(createTemplate());

        expect(service.latestJobTemplateId).toBe(2);
        expect(Object.keys(service.blocks)).toHaveLength(1);
    });

    it('should emit when transaction identity changes without changing transaction count', async () => {
        await firstValueFrom(service.newMiningJob$);

        const reorderedTemplate = createTemplate();
        reorderedTemplate.transactions = [
            reorderedTemplate.transactions[1],
            reorderedTemplate.transactions[0],
            ...reorderedTemplate.transactions.slice(2)
        ];

        const nextTemplate = firstValueFrom(service.newMiningJob$.pipe(skip(1)));
        blockTemplate$.next(reorderedTemplate);
        const jobTemplate = await nextTemplate;

        expect(jobTemplate.blockData.clearJobs).toBe(false);
        expect(jobTemplate.blockData.id).toBe('2');
        expect(service.getJobTemplateById(jobTemplate.blockData.id)).toBe(jobTemplate);
    });

    it('should emit when payout snapshot metadata changes', async () => {
        await firstValueFrom(service.newMiningJob$);

        const payoutTemplate = createTemplate();
        payoutTemplate.payoutSnapshotId = '42';
        payoutTemplate.payoutOutputs = [
            { address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', amountSats: 123456 },
        ];

        const nextTemplate = firstValueFrom(service.newMiningJob$.pipe(skip(1)));
        blockTemplate$.next(payoutTemplate);
        const jobTemplate = await nextTemplate;

        expect(jobTemplate.blockData.clearJobs).toBe(false);
        expect(jobTemplate.blockData.payoutSnapshotId).toBe('42');
        expect(jobTemplate.blockData.payoutOutputs).toEqual(payoutTemplate.payoutOutputs);
    });

    it('should age old jobs and templates after five minutes', async () => {
        await firstValueFrom(service.newMiningJob$);
        const oldCreation = Date.now() - (1000 * 60 * 11);
        service.jobs['old-job'] = { jobId: 'old-job', creation: oldCreation } as any;
        service.blocks['old-template'] = {
            blockData: { creation: oldCreation }
        } as any;

        bitcoinRpcService.miningInfo.blocks = MockRecording1.BLOCK_TEMPLATE.height;
        jest.setSystemTime(new Date(Date.now() + 1000));
        const nextTemplate = firstValueFrom(service.newMiningJob$.pipe(skip(1)));
        blockTemplate$.next(createTemplate());
        const jobTemplate = await nextTemplate;

        expect(jobTemplate.blockData.clearJobs).toBe(false);
        expect(service.getJobById('old-job')).toBeUndefined();
        expect(service.getJobTemplateById('old-template')).toBeUndefined();
        expect(service.getJobTemplateById(jobTemplate.blockData.id)).toBe(jobTemplate);
    });

    it('should honor the configured job retention window', async () => {
        const previousRetention = process.env.STRATUM_JOB_RETENTION_MS;
        process.env.STRATUM_JOB_RETENTION_MS = '1000';
        try {
            const oldTemplate = await firstValueFrom(service.newMiningJob$);
            const oldJob = service.getOrCreateJob(
                bitcoinjs.networks.testnet,
                [{ address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', percent: 100 }],
                oldTemplate,
            );
            oldTemplate.blockData.creation = Date.now() - 1001;
            oldJob.creation = Date.now() - 1001;

            const nextTip = createTemplate(MockRecording1.BLOCK_TEMPLATE.height + 1);
            nextTip.previousblockhash = '33'.repeat(32);
            const nextTemplate = firstValueFrom(service.newMiningJob$.pipe(skip(1)));
            blockTemplate$.next(nextTip);
            await nextTemplate;

            expect(service.getJobById(oldJob.jobId)).toBeUndefined();
            expect(service.getJobTemplateById(oldTemplate.blockData.id)).toBeUndefined();
        } finally {
            if (previousRetention == null) {
                delete process.env.STRATUM_JOB_RETENTION_MS;
            } else {
                process.env.STRATUM_JOB_RETENTION_MS = previousRetention;
            }
        }
    });

    it('keeps clean current-tip work reconstructable beyond the normal retention window', async () => {
        const previousRetention = process.env.STRATUM_JOB_RETENTION_MS;
        process.env.STRATUM_JOB_RETENTION_MS = '1000';
        try {
            const cleanTemplate = await firstValueFrom(service.newMiningJob$);
            const job = service.getOrCreateJob(
                bitcoinjs.networks.testnet,
                [{ address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', percent: 100 }],
                cleanTemplate,
            );
            cleanTemplate.blockData.creation = Date.now() - 10_000;
            job.creation = Date.now() - 10_000;

            const refresh = createTemplate();
            refresh.transactions = refresh.transactions.slice(0, -1);
            const refreshResult = firstValueFrom(service.newMiningJob$.pipe(skip(1)));
            blockTemplate$.next(refresh);
            await refreshResult;

            expect(service.getSubmissionContext(job.jobId)).toEqual(expect.objectContaining({
                status: 'current',
                job,
                jobTemplate: cleanTemplate,
            }));
        } finally {
            if (previousRetention == null) {
                delete process.env.STRATUM_JOB_RETENTION_MS;
            } else {
                process.env.STRATUM_JOB_RETENTION_MS = previousRetention;
            }
        }
    });

    it('should increment job ids when jobs are added', () => {
        expect(service.getNextId()).toBe('1');

        service.addJob({ jobId: '1', creation: Date.now() } as any);

        expect(service.getNextId()).toBe('2');
        expect(service.getJobById('1')).toEqual(expect.objectContaining({ jobId: '1' }));
    });

    it('should cache one mining job per template and payout identity', async () => {
        const template = await firstValueFrom(service.newMiningJob$);
        const payout = [{ address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', percent: 100 }];

        const first = service.getOrCreateJob(bitcoinjs.networks.testnet, payout, template);
        const second = service.getOrCreateJob(bitcoinjs.networks.testnet, [{ ...payout[0] }], template);

        expect(second).toBe(first);
        expect(first.ownership).toEqual(expect.objectContaining({ payoutMode: 'solo' }));
        expect(Object.keys(service.jobs)).toEqual([first.jobId]);
    });

    it('should keep identical payout identities isolated by connection payout mode', async () => {
        const template = await firstValueFrom(service.newMiningJob$);
        const payout = [{ address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', percent: 100 }];

        const solo = service.getOrCreateJob(
            bitcoinjs.networks.testnet,
            payout,
            template,
            'shared-identity',
            'solo',
        );
        const pplns = service.getOrCreateJob(
            bitcoinjs.networks.testnet,
            payout,
            template,
            'shared-identity',
            'pplns',
        );

        expect(pplns).not.toBe(solo);
        expect(solo.ownership).toEqual({ payoutMode: 'solo', payoutIdentity: 'shared-identity' });
        expect(pplns.ownership).toEqual({ payoutMode: 'pplns', payoutIdentity: 'shared-identity' });
    });
});
