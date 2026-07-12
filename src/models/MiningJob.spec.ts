import * as bitcoinjs from 'bitcoinjs-lib';
import { BehaviorSubject, firstValueFrom } from 'rxjs';

import { MockRecording1 } from '../../test/models/MockRecording1';
import { createSubsidyOnlyBlockTemplate } from '../services/subsidy-only-template.factory';
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

    it.each([
        { height: 1, expectedPrefix: '51' },
        { height: 16, expectedPrefix: '60' },
        { height: 17, expectedPrefix: '0111' },
    ])('minimally encodes BIP34 coinbase height $height', ({ height, expectedPrefix }) => {
        const heightTemplate = {
            ...jobTemplate,
            blockData: { ...jobTemplate.blockData, height },
        };
        const heightJob = new MiningJob(
            bitcoinjs.networks.testnet,
            `height-${height}`,
            [{ address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', percent: 100 }],
            heightTemplate,
        );
        const extraNonce1 = '57a6f098';
        const extraNonce2 = 'c708000000000000';
        const coinbase = bitcoinjs.Transaction.fromHex([
            heightJob.getCoinbasePrefixBuffer().toString('hex'),
            extraNonce1,
            extraNonce2,
            heightJob.getCoinbaseSuffixBuffer().toString('hex'),
        ].join(''));

        expect(coinbase.ins[0].script.toString('hex').startsWith(expectedPrefix)).toBe(true);
        expect(coinbase.ins[0].script.toString('hex').endsWith(`${extraNonce1}${extraNonce2}`)).toBe(true);
    });

    it('should expose coinbase prefix and suffix buffers for SV2 extended jobs', () => {
        const notify = JSON.parse(job.response(jobTemplate));
        const extraNonce1 = '57a6f098';
        const extraNonce2 = 'c708000000000000';
        const fromNotify = Buffer.from(`${notify.params[2]}${extraNonce1}${extraNonce2}${notify.params[3]}`, 'hex');
        const fromBuffers = Buffer.concat([
            job.getCoinbasePrefixBuffer(),
            Buffer.from(`${extraNonce1}${extraNonce2}`, 'hex'),
            job.getCoinbaseSuffixBuffer(),
        ]);

        expect(fromBuffers).toEqual(fromNotify);
        expect(bitcoinjs.Transaction.fromBuffer(fromBuffers).ins[0].script.toString('hex'))
            .toContain(`${extraNonce1}${extraNonce2}`);
    });

    it('should support exact satoshi payout outputs', () => {
        const firstAmount = Math.floor(jobTemplate.blockData.coinbasevalue / 3);
        const secondAmount = jobTemplate.blockData.coinbasevalue - firstAmount;
        const exactPayoutJob = new MiningJob(
            bitcoinjs.networks.testnet,
            '2',
            [
                { address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', amountSats: firstAmount },
                { address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', amountSats: secondAmount },
            ],
            jobTemplate
        );
        const coinbase = exactPayoutJob.cloneCoinbaseTransaction();

        expect(coinbase.outs[0].value).toBe(firstAmount);
        expect(coinbase.outs[1].value).toBe(secondAmount);
        expect(coinbase.outs[2].value).toBe(0);
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

    it('replaces negotiated BIP310 bits without toggling bits already set in the job version', () => {
        const versionRollingMask = 0x1fffe000;
        const versionBits = 0x00002000;
        const baseVersion = 0xa0002000 | 0;
        const versionedTemplate = {
            ...jobTemplate,
            block: Object.assign(new bitcoinjs.Block(), jobTemplate.block, {
                version: baseVersion,
            }),
        };
        const expectedVersion = 0xa0002000 >>> 0;

        expect(MiningJob.applyVersionRolling(baseVersion, versionBits, versionRollingMask))
            .toBe(expectedVersion);
        const updatedBlock = job.copyAndUpdateBlock(
            versionedTemplate,
            versionBits,
            parseInt('ed460d91', 16),
            '57a6f098',
            'c708000000000000',
            parseInt(MockRecording1.TIME, 16),
            versionRollingMask,
        );
        const header = job.buildHeaderBuffer(
            versionedTemplate,
            versionBits,
            parseInt('ed460d91', 16),
            '57a6f098',
            'c708000000000000',
            parseInt(MockRecording1.TIME, 16),
            versionRollingMask,
        );

        expect(updatedBlock.version >>> 0).toBe(expectedVersion);
        expect(header.readUInt32LE(0)).toBe(expectedVersion);
        expect(header).toEqual(updatedBlock.toBuffer(true));
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

    it('hydrates the raw transaction body only when reconstructing a full candidate', () => {
        const versionMask = parseInt('00002000', 16);
        const nonce = parseInt('ed460d91', 16);
        const extraNonce1 = '57a6f098';
        const extraNonce2 = 'c708000000000000';
        const timestamp = parseInt(MockRecording1.TIME, 16);
        const fromHexSpy = jest.spyOn(bitcoinjs.Transaction, 'fromHex');

        const merkleRoot = job.buildCoinbaseMerkleRoot(extraNonce1, extraNonce2);
        job.buildHeaderBuffer(
            jobTemplate,
            versionMask,
            nonce,
            extraNonce1,
            extraNonce2,
            timestamp,
        );
        expect(fromHexSpy).not.toHaveBeenCalled();

        const candidate = job.copyAndUpdateBlock(
            jobTemplate,
            versionMask,
            nonce,
            extraNonce1,
            extraNonce2,
            timestamp,
        );

        expect(fromHexSpy).toHaveBeenCalledTimes(jobTemplate.blockData.transactions.length);
        expect(candidate.transactions).toHaveLength(jobTemplate.blockData.transactions.length + 1);
        expect(candidate.transactions.slice(1).map(transaction => transaction.toHex()))
            .toEqual(jobTemplate.blockData.transactions.map(transaction => transaction.data));
        expect(candidate.transactions.slice(1).map(transaction => transaction.getId()))
            .toEqual(jobTemplate.blockData.transactions.map(transaction => transaction.txid));
        expect(candidate.merkleRoot).toEqual(merkleRoot);
        expect(bitcoinjs.Block.calculateMerkleRoot(candidate.transactions, false))
            .toEqual(candidate.merkleRoot);
        expect(candidate.checkTxRoots()).toBe(true);
    });

    it('rejects a lazily hydrated candidate body whose bytes do not match the GBT txid', () => {
        const corruptedTemplate = {
            ...jobTemplate,
            blockData: {
                ...jobTemplate.blockData,
                transactions: jobTemplate.blockData.transactions.map((transaction, index) => ({
                    ...transaction,
                    txid: index === 0 ? '00'.repeat(32) : transaction.txid,
                })),
            },
        };

        expect(() => job.copyAndUpdateBlock(
            corruptedTemplate,
            0,
            1,
            '57a6f098',
            'c708000000000000',
            parseInt(MockRecording1.TIME, 16),
        )).toThrow('data does not match its txid');
    });

    it('builds a consensus-shaped subsidy bridge with one coinbase and a clean notify', async () => {
        const authoritative = {
            ...MockRecording1.BLOCK_TEMPLATE,
            height: 840_000,
            transactions: MockRecording1.BLOCK_TEMPLATE.transactions.map(tx => ({ ...tx })),
        };
        authoritative.coinbasevalue = 312_500_000
            + authoritative.transactions.reduce((sum, transaction) => sum + transaction.fee, 0);
        const emptyTemplate = createSubsidyOnlyBlockTemplate({
            authoritativeTemplate: authoritative,
            network: 'mainnet',
            payoutMode: 'solo',
        });
        const emptyTemplate$ = new BehaviorSubject(emptyTemplate);
        const jobsService = new StratumV1JobsService({
            newBlockTemplate$: emptyTemplate$.asObservable(),
            miningInfo: { blocks: emptyTemplate.height - 1 },
        } as any);
        const emptyJobTemplate = await firstValueFrom(jobsService.newMiningJob$);
        const emptyJob = new MiningJob(
            bitcoinjs.networks.testnet,
            'bridge',
            [{ address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', percent: 100 }],
            emptyJobTemplate,
        );

        const notify = JSON.parse(emptyJob.response(emptyJobTemplate));
        const fromHexSpy = jest.spyOn(bitcoinjs.Transaction, 'fromHex');
        const reconstructed = emptyJob.copyAndUpdateBlock(
            emptyJobTemplate,
            0,
            1,
            '57a6f098',
            'c708000000000000',
            emptyJobTemplate.block.timestamp,
        );
        const coinbaseScript = reconstructed.transactions[0].ins[0].script;
        const encodedHeight = coinbaseScript.subarray(1, 1 + coinbaseScript[0]);

        expect(emptyJobTemplate.merkle_branch).toEqual([]);
        expect(notify.params[8]).toBe(true);
        expect(fromHexSpy).not.toHaveBeenCalled();
        expect(reconstructed.transactions).toHaveLength(1);
        expect(reconstructed.transactions[0].outs.reduce((sum, output) => sum + output.value, 0))
            .toBe(312_500_000);
        expect(bitcoinjs.script.number.decode(encodedHeight)).toBe(840_000);
        expect(reconstructed.transactions[0].outs[1].script.toString('hex'))
            .toBe(emptyTemplate.default_witness_commitment);
        expect(bitcoinjs.Block.calculateMerkleRoot(reconstructed.transactions, false))
            .toEqual(reconstructed.merkleRoot);
    });
});
