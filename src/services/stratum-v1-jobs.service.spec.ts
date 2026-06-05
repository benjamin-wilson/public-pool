import { BehaviorSubject, firstValueFrom } from 'rxjs';

import { MockRecording1 } from '../../test/models/MockRecording1';
import { IMiningInfo } from '../models/bitcoin-rpc/IMiningInfo';
import { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { StratumV1JobsService } from './stratum-v1-jobs.service';

describe('StratumV1JobsService', () => {
    let miningInfo$: BehaviorSubject<IMiningInfo>;
    let bitcoinRpcService: { newBlock$: any, getBlockTemplate: jest.Mock };
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

        miningInfo$ = new BehaviorSubject({
            blocks: MockRecording1.BLOCK_TEMPLATE.height
        } as IMiningInfo);
        bitcoinRpcService = {
            newBlock$: miningInfo$.asObservable(),
            getBlockTemplate: jest.fn((height: number) => Promise.resolve(createTemplate(height)))
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

        const nextTemplate = firstValueFrom(service.newMiningJob$);
        miningInfo$.next({
            blocks: MockRecording1.BLOCK_TEMPLATE.height + 1
        } as IMiningInfo);
        const jobTemplate = await nextTemplate;

        expect(jobTemplate.blockData.clearJobs).toBe(true);
        expect(service.getJobById('old-job')).toBeUndefined();
        expect(service.getJobTemplateById(firstTemplate.blockData.id)).toBeUndefined();
        expect(service.getJobTemplateById(jobTemplate.blockData.id)).toBe(jobTemplate);
    });

    it('should skip identical non-clean template refreshes', async () => {
        await firstValueFrom(service.newMiningJob$);

        miningInfo$.next({
            blocks: MockRecording1.BLOCK_TEMPLATE.height
        } as IMiningInfo);

        expect(service.latestJobTemplateId).toBe(2);
        expect(Object.keys(service.blocks)).toHaveLength(1);
    });

    it('should emit when transaction identity changes without changing transaction count', async () => {
        await firstValueFrom(service.newMiningJob$);
        const emissions = [];
        const subscription = service.newMiningJob$.subscribe(jobTemplate => {
            emissions.push(jobTemplate);
        });
        await Promise.resolve();

        const changedTemplate = createTemplate();
        changedTemplate.transactions[0] = {
            ...changedTemplate.transactions[0],
            hash: `${changedTemplate.transactions[0].hash}-changed`
        };
        bitcoinRpcService.getBlockTemplate.mockResolvedValueOnce(changedTemplate);

        miningInfo$.next({
            blocks: MockRecording1.BLOCK_TEMPLATE.height
        } as IMiningInfo);
        await Promise.resolve();
        await Promise.resolve();
        subscription.unsubscribe();
        const jobTemplate = emissions[emissions.length - 1];

        expect(jobTemplate.blockData.clearJobs).toBe(false);
        expect(jobTemplate.blockData.id).toBe('2');
        expect(service.getJobTemplateById(jobTemplate.blockData.id)).toBe(jobTemplate);
    });

    it('should age old jobs and templates after five minutes', async () => {
        await firstValueFrom(service.newMiningJob$);
        const oldCreation = Date.now() - (1000 * 60 * 11);
        service.jobs['old-job'] = { jobId: 'old-job', creation: oldCreation } as any;
        service.blocks['old-template'] = {
            blockData: { creation: oldCreation }
        } as any;

        jest.setSystemTime(new Date(Date.now() + (1000 * 60 * 11)));
        const nextTemplate = firstValueFrom(service.newMiningJob$);
        miningInfo$.next({
            blocks: MockRecording1.BLOCK_TEMPLATE.height
        } as IMiningInfo);
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
