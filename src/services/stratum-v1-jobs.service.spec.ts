import { BehaviorSubject, firstValueFrom, skip } from 'rxjs';

import { MockRecording1 } from '../../test/models/MockRecording1';
import { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { StratumV1JobsService } from './stratum-v1-jobs.service';

describe('StratumV1JobsService', () => {
    let blockTemplate$: BehaviorSubject<IBlockTemplate>;
    let bitcoinRpcService: { newBlockTemplate$: any, miningInfo: { blocks: number } };
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
        bitcoinRpcService = {
            newBlockTemplate$: blockTemplate$.asObservable(),
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

        expect(jobTemplate.blockData).toEqual(expect.objectContaining({
            id: '1',
            height: MockRecording1.BLOCK_TEMPLATE.height,
            clearJobs: true,
            coinbasevalue: MockRecording1.BLOCK_TEMPLATE.coinbasevalue
        }));
        expect(jobTemplate.merkle_branch.length).toBeGreaterThan(0);
        expect(jobTemplate.block.transactions[0].ins[0].witness[0]).toHaveLength(32);
        expect(service.getJobTemplateById('1')).toBe(jobTemplate);
    });

    it('should clear jobs when the block height changes', async () => {
        const firstTemplate = await firstValueFrom(service.newMiningJob$);
        service.addJob({ jobId: 'old-job', creation: Date.now() } as any);

        bitcoinRpcService.miningInfo.blocks = MockRecording1.BLOCK_TEMPLATE.height + 1;
        const nextTemplate = firstValueFrom(service.newMiningJob$.pipe(skip(1)));
        blockTemplate$.next(createTemplate(MockRecording1.BLOCK_TEMPLATE.height + 1));
        const jobTemplate = await nextTemplate;

        expect(jobTemplate.blockData.clearJobs).toBe(true);
        expect(service.getJobById('old-job')).toBeUndefined();
        expect(service.getJobTemplateById(firstTemplate.blockData.id)).toBeUndefined();
        expect(service.getJobTemplateById(jobTemplate.blockData.id)).toBe(jobTemplate);
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

    it('should increment job ids when jobs are added', () => {
        expect(service.getNextId()).toBe('1');

        service.addJob({ jobId: '1', creation: Date.now() } as any);

        expect(service.getNextId()).toBe('2');
        expect(service.getJobById('1')).toEqual(expect.objectContaining({ jobId: '1' }));
    });
});
