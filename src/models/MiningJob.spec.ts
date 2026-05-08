import * as bitcoinjs from 'bitcoinjs-lib';
import { BehaviorSubject, firstValueFrom } from 'rxjs';

import { MockRecording1 } from '../../test/models/MockRecording1';
import { StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { MiningJob } from './MiningJob';

describe('MiningJob', () => {
    let jobTemplate;
    let job: MiningJob;

    beforeEach(async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(parseInt(MockRecording1.TIME, 16) * 1000));

        const blockTemplate$ = new BehaviorSubject(MockRecording1.BLOCK_TEMPLATE);
        const bitcoinRpcService = {
            newBlockTemplate$: blockTemplate$.asObservable(),
            miningInfo: { blocks: MockRecording1.BLOCK_TEMPLATE.height }
        };
        jest.spyOn(console, 'log').mockImplementation(() => undefined);

        const jobsService = new StratumV1JobsService(bitcoinRpcService as any);
        jobTemplate = await firstValueFrom(jobsService.newMiningJob$);
        job = new MiningJob(
            bitcoinjs.networks.testnet,
            '1',
            [{ address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', percent: 100 }],
            jobTemplate
        );
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    it('should split coinbase around 12 bytes of extranonce space', () => {
        const notify = JSON.parse(job.response(jobTemplate));
        const coinbasePart1 = notify.params[2];
        const coinbasePart2 = notify.params[3];
        const extraNonce1 = '57a6f098';
        const extraNonce2 = 'c708000000000000';
        const coinbase = bitcoinjs.Transaction.fromHex(`${coinbasePart1}${extraNonce1}${extraNonce2}${coinbasePart2}`);

        expect(Buffer.byteLength(extraNonce1 + extraNonce2, 'hex')).toBe(12);
        expect(coinbase.ins[0].script.toString('hex')).toContain(`${extraNonce1}${extraNonce2}`);
        expect(coinbase.ins[0].script.toString('hex').endsWith(`${extraNonce1}${extraNonce2}`)).toBe(true);
    });

    it('should update block nonce, timestamp, version mask, and coinbase script', () => {
        const extraNonce1 = '57a6f098';
        const extraNonce2 = 'c708000000000000';
        const timestamp = parseInt(MockRecording1.TIME, 16);
        const originalMerkleRoot = Buffer.from(jobTemplate.block.merkleRoot);

        const updatedBlock = job.copyAndUpdateBlock(
            jobTemplate,
            parseInt('00002000', 16),
            parseInt('ed460d91', 16),
            extraNonce1,
            extraNonce2,
            timestamp
        );

        expect(updatedBlock.nonce).toBe(parseInt('ed460d91', 16));
        expect(updatedBlock.timestamp).toBe(timestamp);
        expect(updatedBlock.version).toBe(jobTemplate.block.version ^ parseInt('00002000', 16));
        expect(updatedBlock.transactions[0].ins[0].script.toString('hex').endsWith(`${extraNonce1}${extraNonce2}`)).toBe(true);
        expect(updatedBlock.merkleRoot.equals(originalMerkleRoot)).toBe(false);
    });

    it('should leave block version unchanged without a version mask', () => {
        const updatedBlock = job.copyAndUpdateBlock(
            jobTemplate,
            0,
            parseInt('ed460d91', 16),
            '57a6f098',
            'c708000000000000',
            parseInt(MockRecording1.TIME, 16)
        );

        expect(updatedBlock.version).toBe(jobTemplate.block.version);
    });

    it('should build the same header as the full block update path', () => {
        const versionMask = parseInt('00002000', 16);
        const nonce = parseInt('ed460d91', 16);
        const extraNonce1 = '57a6f098';
        const extraNonce2 = 'c708000000000000';
        const timestamp = parseInt(MockRecording1.TIME, 16);

        const updatedBlock = job.copyAndUpdateBlock(
            jobTemplate,
            versionMask,
            nonce,
            extraNonce1,
            extraNonce2,
            timestamp
        );
        const fastHeader = job.buildHeaderBuffer(
            jobTemplate,
            versionMask,
            nonce,
            extraNonce1,
            extraNonce2,
            timestamp
        );

        expect(fastHeader.equals(updatedBlock.toBuffer(true))).toBe(true);
    });
});
