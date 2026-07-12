import { ConfigService } from '@nestjs/config';
import * as bitcoinjs from 'bitcoinjs-lib';
import { Socket } from 'net';
import { BehaviorSubject, firstValueFrom } from 'rxjs';

import { MockRecording1 } from '../../test/models/MockRecording1';
import { ClientEntity } from '../ORM/client/client.entity';
import { CustomWorkService } from '../services/custom-work.service';
import { StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { DifficultyUtils } from '../utils/difficulty.utils';
import { hash256 } from '../utils/hash.utils';
import { BufferReader } from './sv2/sv2-binary-codec';
import { SV2_CHANNEL_MSG_FLAG, Sv2MiningSetupFlags, Sv2MsgType, Sv2Protocol } from './sv2/sv2-constants';
import {
    deserializeOpenExtendedMiningChannelSuccess,
    deserializeNewExtendedMiningJob,
    serializeOpenExtendedMiningChannel,
    serializeSubmitSharesExtended,
} from './sv2/sv2-extended-messages';
import {
    deserializeNewMiningJob,
    deserializeSetNewPrevHash,
    deserializeSubmitSharesError,
    deserializeSubmitSharesSuccess,
    serializeCloseChannel,
    serializeOpenStandardMiningChannel,
    serializeSetupConnection,
    serializeSubmitSharesStandard,
    serializeUpdateChannel,
} from './sv2/sv2-messages';
import {
    deserializeSetCustomMiningJobError,
    deserializeSetCustomMiningJobSuccess,
    serializeSetCustomMiningJob,
} from './sv2/sv2-jdp-messages';
import { MiningJob } from './MiningJob';
import { StratumV2Client } from './StratumV2Client';

describe('StratumV2Client extended channels', () => {
    let consoleLogSpy: jest.SpyInstance;
    let consoleWarnSpy: jest.SpyInstance;
    let consoleErrorSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(parseInt(MockRecording1.TIME, 16) * 1000));
        consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        consoleLogSpy.mockRestore();
        consoleWarnSpy.mockRestore();
        consoleErrorSpy.mockRestore();
        jest.useRealTimers();
    });

    it('creates standard canonical and future jobs without parsing the full transaction body', async () => {
        const fromHex = jest.spyOn(bitcoinjs.Transaction, 'fromHex');
        const { client, sentFrames } = await createClient();

        await (client as any).handleOpenStandardMiningChannel(serializeOpenStandardMiningChannel({
            requestId: 1,
            user_identity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
        }));

        expect(sentFrames.filter(frame => frame.msgType === Sv2MsgType.NEW_MINING_JOB))
            .toHaveLength(2);
        expect(fromHex).not.toHaveBeenCalled();
    });

    it('opens an extended channel and sends initial extended work', async () => {
        const { client, sentFrames } = await createClient();
        const maxTarget = Buffer.alloc(32, 0xff);

        await (client as any).handleOpenExtendedMiningChannel(serializeOpenExtendedMiningChannel({
            requestId: 7,
            userIdentity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget,
            minExtranonceSize: 8,
        }));

        const successFrame = sentFrames.find(frame => frame.msgType === Sv2MsgType.OPEN_EXTENDED_MINING_CHANNEL_SUCCESS);
        const jobFrames = sentFrames.filter(frame => frame.msgType === Sv2MsgType.NEW_EXTENDED_MINING_JOB);
        const prevHashFrames = sentFrames.filter(frame => frame.msgType === Sv2MsgType.SET_NEW_PREV_HASH);
        const prevHashFrame = prevHashFrames[prevHashFrames.length - 1];
        const prevHash = deserializeSetNewPrevHash(new BufferReader(prevHashFrame.payload));
        const jobFrame = jobFrames.find(frame =>
            deserializeNewExtendedMiningJob(new BufferReader(frame.payload)).jobId === prevHash.jobId);

        expect(successFrame?.extensionType).toBe(0);
        const success = deserializeOpenExtendedMiningChannelSuccess(new BufferReader(successFrame.payload));
        expect(success.requestId).toBe(7);
        expect(success.channelId).toBe(1);
        expect(success.extranonceSize).toBe(10);
        expect(success.extranoncePrefix).toEqual(Buffer.from('00000001', 'hex'));

        expect(jobFrame?.extensionType).toBe(SV2_CHANNEL_MSG_FLAG);
        const job = deserializeNewExtendedMiningJob(new BufferReader(jobFrame.payload));
        expect(job.channelId).toBe(1);
        expect(job.minNtime).toBeNull();
        expect(job.coinbasePrefix.length).toBeGreaterThan(0);
        expect(job.coinbaseSuffix.length).toBeGreaterThan(0);
        expect(job.merklePath.length).toBeGreaterThan(0);

        expect(prevHashFrame?.extensionType).toBe(SV2_CHANNEL_MSG_FLAG);
        expect(prevHash.channelId).toBe(1);
        expect(prevHash.jobId).toBe(job.jobId);
        const futureJob = deserializeNewExtendedMiningJob(new BufferReader(jobFrames.at(-1).payload));
        expect(futureJob.jobId).not.toBe(job.jobId);
        expect(futureJob.minNtime).toBeNull();
        expect(futureJob.merklePath).toHaveLength(0);
    });

    it('keeps PPLNS channels on explicit payout work during legacy all-mode rollout', async () => {
        const { client, sentFrames, jobTemplate } = await createClient('pplns');
        await (client as any).handleOpenExtendedMiningChannel(serializeOpenExtendedMiningChannel({
            requestId: 1,
            userIdentity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
            minExtranonceSize: 8,
        }));

        expect(jobTemplate.blockData.payoutMode).toBe('all');
        expect(jobTemplate.blockData.payoutOutputs).toBeUndefined();
        expect(sentFrames.some(frame => frame.msgType === Sv2MsgType.NEW_EXTENDED_MINING_JOB)).toBe(false);
        const channel = (client as any).channels.get(1);
        expect(channel.extendedJobs.size).toBe(0);

        const explicitPplnsTemplate = {
            ...jobTemplate,
            block: Object.assign(new bitcoinjs.Block(), jobTemplate.block),
            blockData: {
                ...jobTemplate.blockData,
                id: 'explicit-pplns',
                payoutMode: 'pplns' as const,
                payoutSnapshotId: 'snapshot-1',
                payoutOutputs: [{
                    address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
                    amountSats: jobTemplate.blockData.coinbasevalue,
                }],
            },
        };
        sentFrames.length = 0;
        await client.enqueueCanonicalJob(explicitPplnsTemplate);
        const activation = deserializeSetNewPrevHash(new BufferReader(sentFrames
            .find(frame => frame.msgType === Sv2MsgType.SET_NEW_PREV_HASH).payload));
        const activeJob = channel.extendedJobs.get(activation.jobId);
        expect(activeJob.retiredAt).toBeUndefined();

        sentFrames.length = 0;
        await client.enqueueCanonicalJob(jobTemplate);
        expect(sentFrames).toHaveLength(0);
        expect(channel.extendedJobs.size).toBe(1);
        expect(activeJob.retiredAt).toBeUndefined();
    });

    it('rejects extended shares with the wrong negotiated extranonce size', async () => {
        const { client, sentFrames } = await createClient();
        await (client as any).handleOpenExtendedMiningChannel(serializeOpenExtendedMiningChannel({
            requestId: 1,
            userIdentity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
            minExtranonceSize: 8,
        }));
        const jobFrames = sentFrames.filter(frame => frame.msgType === Sv2MsgType.NEW_EXTENDED_MINING_JOB);
        const jobFrame = jobFrames[jobFrames.length - 1];
        const job = deserializeNewExtendedMiningJob(new BufferReader(jobFrame.payload));
        sentFrames.length = 0;

        await (client as any).handleSubmitSharesExtended(serializeSubmitSharesExtended({
            channelId: 1,
            sequenceNumber: 42,
            jobId: job.jobId,
            nonce: 0,
            ntime: parseInt(MockRecording1.TIME, 16),
            version: job.version,
            extranonce: Buffer.alloc(7),
        }));

        const errorFrame = sentFrames.find(frame => frame.msgType === Sv2MsgType.SUBMIT_SHARES_ERROR);
        expect(errorFrame?.extensionType).toBe(SV2_CHANNEL_MSG_FLAG);
        const error = deserializeSubmitSharesError(new BufferReader(errorFrame.payload));
        expect(error.channelId).toBe(1);
        expect(error.sequenceNumber).toBe(42);
        expect(error.errorCode).toBe('invalid-extranonce-size');
    });

    it('submits standard network candidates that miss a harder channel target', async () => {
        const { client, sentFrames, bitcoinRpcService, shareAccountingService } = await createClient();
        await (client as any).handleOpenStandardMiningChannel(serializeOpenStandardMiningChannel({
            requestId: 1,
            user_identity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
        }));
        const activation = deserializeSetNewPrevHash(new BufferReader(sentFrames
            .filter(frame => frame.msgType === Sv2MsgType.SET_NEW_PREV_HASH)
            .at(-1).payload));
        const channel = (client as any).channels.get(1);
        const job = channel.standardJobs.get(activation.jobId);
        channel.jobIdToDifficulty.set(activation.jobId, 1000);

        const calculateDifficulty = jest.spyOn(DifficultyUtils, 'calculateDifficulty').mockReturnValue({
            submissionDifficulty: 123,
            submissionHash: '00'.repeat(32),
            hashBuffer: Buffer.alloc(32),
        });
        const meetsCompactTarget = jest.spyOn(DifficultyUtils, 'meetsCompactTarget').mockReturnValue(true);
        const meetsTarget = jest.spyOn(DifficultyUtils, 'meetsTarget').mockReturnValue(false);
        sentFrames.length = 0;
        try {
            await (client as any).handleSubmitSharesStandard(serializeSubmitSharesStandard({
                channelId: 1,
                sequenceNumber: 41,
                jobId: activation.jobId,
                nonce: 1,
                ntime: activation.minNtime,
                version: job.expectedVersion,
            }));
        } finally {
            calculateDifficulty.mockRestore();
            meetsCompactTarget.mockRestore();
            meetsTarget.mockRestore();
        }

        expect(sentFrames.some(frame => frame.msgType === Sv2MsgType.SUBMIT_SHARES_ERROR)).toBe(false);
        const successFrame = sentFrames.find(frame => frame.msgType === Sv2MsgType.SUBMIT_SHARES_SUCCESS);
        const success = deserializeSubmitSharesSuccess(new BufferReader(successFrame.payload));
        expect(success.newSharesSum).toBe(123n);
        expect(bitcoinRpcService.SUBMIT_BLOCK).toHaveBeenCalledTimes(1);
        expect(shareAccountingService.recordAcceptedShare).toHaveBeenCalledWith(expect.objectContaining({
            creditedDifficulty: 123,
            submissionDifficulty: 123,
            isBlockCandidate: true,
        }));
    });

    it('submits extended network candidates that miss a harder channel target', async () => {
        const { client, sentFrames, bitcoinRpcService, shareAccountingService } = await createClient();
        await (client as any).handleOpenExtendedMiningChannel(serializeOpenExtendedMiningChannel({
            requestId: 1,
            userIdentity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
            minExtranonceSize: 8,
        }));
        const activation = deserializeSetNewPrevHash(new BufferReader(sentFrames
            .filter(frame => frame.msgType === Sv2MsgType.SET_NEW_PREV_HASH)
            .at(-1).payload));
        const channel = (client as any).channels.get(1);
        const job = channel.extendedJobs.get(activation.jobId);
        channel.jobIdToDifficulty.set(activation.jobId, 1000);

        const calculateDifficulty = jest.spyOn(DifficultyUtils, 'calculateDifficulty').mockReturnValue({
            submissionDifficulty: 123,
            submissionHash: '00'.repeat(32),
            hashBuffer: Buffer.alloc(32),
        });
        const meetsCompactTarget = jest.spyOn(DifficultyUtils, 'meetsCompactTarget').mockReturnValue(true);
        const meetsTarget = jest.spyOn(DifficultyUtils, 'meetsTarget').mockReturnValue(false);
        sentFrames.length = 0;
        try {
            await (client as any).handleSubmitSharesExtended(serializeSubmitSharesExtended({
                channelId: 1,
                sequenceNumber: 42,
                jobId: activation.jobId,
                nonce: 1,
                ntime: activation.minNtime,
                version: job.expectedVersion,
                extranonce: Buffer.alloc(channel.extranonceSize, 0x42),
            }));
        } finally {
            calculateDifficulty.mockRestore();
            meetsCompactTarget.mockRestore();
            meetsTarget.mockRestore();
        }

        expect(sentFrames.some(frame => frame.msgType === Sv2MsgType.SUBMIT_SHARES_ERROR)).toBe(false);
        const successFrame = sentFrames.find(frame => frame.msgType === Sv2MsgType.SUBMIT_SHARES_SUCCESS);
        const success = deserializeSubmitSharesSuccess(new BufferReader(successFrame.payload));
        expect(success.newSharesSum).toBe(123n);
        expect(bitcoinRpcService.SUBMIT_BLOCK).toHaveBeenCalledTimes(1);
        expect(shareAccountingService.recordAcceptedShare).toHaveBeenCalledWith(expect.objectContaining({
            creditedDifficulty: 123,
            submissionDifficulty: 123,
            isBlockCandidate: true,
        }));
    });

    it('reconstructs extended-channel block candidates with a matching merkle root', async () => {
        const { client, sentFrames } = await createClient();
        await (client as any).handleOpenExtendedMiningChannel(serializeOpenExtendedMiningChannel({
            requestId: 1,
            userIdentity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
            minExtranonceSize: 8,
        }));
        const activeJobId = deserializeSetNewPrevHash(new BufferReader(sentFrames
            .filter(frame => frame.msgType === Sv2MsgType.SET_NEW_PREV_HASH)
            .at(-1).payload)).jobId;
        const jobFrame = sentFrames
            .filter(frame => frame.msgType === Sv2MsgType.NEW_EXTENDED_MINING_JOB)
            .find(frame => deserializeNewExtendedMiningJob(new BufferReader(frame.payload)).jobId === activeJobId);
        const job = deserializeNewExtendedMiningJob(new BufferReader(jobFrame.payload));
        const channel = (client as any).channels.get(1);
        const extendedJob = channel.extendedJobs.get(job.jobId);
        const extranonce = Buffer.alloc(channel.extranonceSize, 0x42);
        const coinbaseTxBytes = Buffer.concat([
            extendedJob.coinbasePrefix,
            channel.extranoncePrefix,
            extranonce,
            extendedJob.coinbaseSuffix,
        ]);
        let merkleRoot = hash256(coinbaseTxBytes);
        for (const sibling of extendedJob.merklePath) {
            merkleRoot = hash256(Buffer.concat([merkleRoot, sibling]));
        }

        const block = (client as any).reconstructExtendedBlock(
            extendedJob,
            {
                jobId: job.jobId,
                nonce: 123,
                ntime: parseInt(MockRecording1.TIME, 16),
                version: job.version,
                extranonce,
            },
            merkleRoot,
            channel.extranoncePrefix,
        );

        expect(block.merkleRoot.equals(bitcoinjs.Block.calculateMerkleRoot(block.transactions, false))).toBe(true);
        expect(block.transactions[0].ins[0].witness).toEqual([Buffer.alloc(32)]);
        const strippedCoinbase = bitcoinjs.Transaction.fromBuffer(block.transactions[0].toBuffer());
        strippedCoinbase.ins[0].witness = [];
        expect(strippedCoinbase.toBuffer()).toEqual(coinbaseTxBytes);
    });

    it('accepts SV2 work-selection setup and SetCustomMiningJob without sending pool work', async () => {
        const { client, sentFrames } = await createClient();
        await (client as any).handleSetupConnection(serializeSetupConnection({
            protocol: Sv2Protocol.MINING,
            minVersion: 2,
            maxVersion: 2,
            flags: Sv2MiningSetupFlags.REQUIRES_WORK_SELECTION | Sv2MiningSetupFlags.REQUIRES_VERSION_ROLLING,
            endpoint_host: 'localhost',
            endpoint_port: 3333,
            vendor: 'jd-client',
            hardwareVersion: '',
            firmwareVersion: '',
            deviceId: '',
        }));

        await (client as any).handleOpenExtendedMiningChannel(serializeOpenExtendedMiningChannel({
            requestId: 1,
            userIdentity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
            minExtranonceSize: 8,
        }));
        expect(sentFrames.some(frame => frame.msgType === Sv2MsgType.NEW_EXTENDED_MINING_JOB)).toBe(false);

        sentFrames.length = 0;
        await (client as any).handleSetCustomMiningJob(serializeSetCustomMiningJob({
            channelId: 1,
            requestId: 99,
            token: Buffer.from('aa', 'hex'),
            version: MockRecording1.BLOCK_TEMPLATE.version,
            prevHash: Buffer.alloc(32, 1),
            minNtime: parseInt(MockRecording1.TIME, 16),
            nBits: parseInt(MockRecording1.BLOCK_TEMPLATE.bits, 16),
            coinbaseTxVersion: 2,
            coinbasePrefix: Buffer.from('51', 'hex'),
            coinbaseTxInputNSequence: 0xffffffff,
            coinbaseTxOutputs: serializeCoinbaseOutputs([
                {
                    address: 'tb1qdyjakeepue4trak9d3hvyelrd0aw7mwju2d0c2',
                    amountSats: 0,
                },
                {
                    address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
                    amountSats: MockRecording1.BLOCK_TEMPLATE.coinbasevalue,
                },
            ]),
            coinbaseTxLocktime: 0,
            merklePath: [],
        }));

        const successFrame = sentFrames.find(frame => frame.msgType === Sv2MsgType.SET_CUSTOM_MINING_JOB_SUCCESS);
        const success = deserializeSetCustomMiningJobSuccess(new BufferReader(successFrame.payload));
        expect(success.channelId).toBe(1);
        expect(success.requestId).toBe(99);
        const customJob = (client as any).channels.get(1).extendedJobs.get(success.jobId);
        expect(customJob.workProtocol).toBe('sv2_jdp');
        expect(customJob.headerContext.activationMinNtime).toBe(parseInt(MockRecording1.TIME, 16));
        expect(typeof customJob.headerContext.activatedAtMonotonicNs).toBe('bigint');
        expect((client as any).isSubmissionHeaderValid(
            customJob.headerContext,
            customJob.expectedVersion,
            customJob.headerContext.minNtime + 1,
        )).toBe(true);

        const calculateDifficulty = jest.spyOn(DifficultyUtils, 'calculateDifficulty').mockReturnValue({
            submissionDifficulty: 123,
            submissionHash: '00'.repeat(32),
            hashBuffer: Buffer.alloc(32),
        });
        const meetsCompactTarget = jest.spyOn(DifficultyUtils, 'meetsCompactTarget').mockReturnValue(true);
        const meetsTarget = jest.spyOn(DifficultyUtils, 'meetsTarget').mockReturnValue(false);
        sentFrames.length = 0;
        try {
            const channel = (client as any).channels.get(1);
            await (client as any).handleSubmitSharesExtended(serializeSubmitSharesExtended({
                channelId: 1,
                sequenceNumber: 100,
                jobId: success.jobId,
                nonce: 1,
                ntime: customJob.headerContext.minNtime,
                version: customJob.expectedVersion,
                extranonce: Buffer.alloc(channel.extranonceSize),
            }));
        } finally {
            calculateDifficulty.mockRestore();
            meetsCompactTarget.mockRestore();
            meetsTarget.mockRestore();
        }
        const shareError = deserializeSubmitSharesError(new BufferReader(sentFrames
            .find(frame => frame.msgType === Sv2MsgType.SUBMIT_SHARES_ERROR).payload));
        expect(shareError.errorCode).toBe('difficulty-too-low');
    });

    it('rejects PPLNS custom jobs when only a legacy template without payout outputs is available', async () => {
        const { client, sentFrames } = await createClient('pplns');
        await (client as any).handleSetupConnection(serializeSetupConnection({
            protocol: Sv2Protocol.MINING,
            minVersion: 2,
            maxVersion: 2,
            flags: Sv2MiningSetupFlags.REQUIRES_WORK_SELECTION | Sv2MiningSetupFlags.REQUIRES_VERSION_ROLLING,
            endpoint_host: 'localhost',
            endpoint_port: 3333,
            vendor: 'jd-client',
            hardwareVersion: '',
            firmwareVersion: '',
            deviceId: '',
        }));
        await (client as any).handleOpenExtendedMiningChannel(serializeOpenExtendedMiningChannel({
            requestId: 1,
            userIdentity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
            minExtranonceSize: 8,
        }));

        sentFrames.length = 0;
        await (client as any).handleSetCustomMiningJob(serializeSetCustomMiningJob({
            channelId: 1,
            requestId: 101,
            token: Buffer.from('aa', 'hex'),
            version: MockRecording1.BLOCK_TEMPLATE.version,
            prevHash: Buffer.alloc(32, 1),
            minNtime: parseInt(MockRecording1.TIME, 16),
            nBits: parseInt(MockRecording1.BLOCK_TEMPLATE.bits, 16),
            coinbaseTxVersion: 2,
            coinbasePrefix: Buffer.from('51', 'hex'),
            coinbaseTxInputNSequence: 0xffffffff,
            coinbaseTxOutputs: Buffer.from('00', 'hex'),
            coinbaseTxLocktime: 0,
            merklePath: [],
        }));

        const errorFrame = sentFrames.find(frame => frame.msgType === Sv2MsgType.SET_CUSTOM_MINING_JOB_ERROR);
        const error = deserializeSetCustomMiningJobError(new BufferReader(errorFrame.payload));
        expect(error.channelId).toBe(1);
        expect(error.requestId).toBe(101);
        expect(error.errorCode).toBe('template-not-found');
        expect((client as any).channels.get(1).extendedJobs.size).toBe(0);
    });

    it('rejects SV2 work-selection custom jobs that do not pay the pool coinbase outputs', async () => {
        const { client, sentFrames } = await createClient();
        await (client as any).handleSetupConnection(serializeSetupConnection({
            protocol: Sv2Protocol.MINING,
            minVersion: 2,
            maxVersion: 2,
            flags: Sv2MiningSetupFlags.REQUIRES_WORK_SELECTION | Sv2MiningSetupFlags.REQUIRES_VERSION_ROLLING,
            endpoint_host: 'localhost',
            endpoint_port: 3333,
            vendor: 'jd-client',
            hardwareVersion: '',
            firmwareVersion: '',
            deviceId: '',
        }));
        await (client as any).handleOpenExtendedMiningChannel(serializeOpenExtendedMiningChannel({
            requestId: 1,
            userIdentity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
            minExtranonceSize: 8,
        }));

        sentFrames.length = 0;
        await (client as any).handleSetCustomMiningJob(serializeSetCustomMiningJob({
            channelId: 1,
            requestId: 100,
            token: Buffer.from('aa', 'hex'),
            version: MockRecording1.BLOCK_TEMPLATE.version,
            prevHash: Buffer.alloc(32, 1),
            minNtime: parseInt(MockRecording1.TIME, 16),
            nBits: parseInt(MockRecording1.BLOCK_TEMPLATE.bits, 16),
            coinbaseTxVersion: 2,
            coinbasePrefix: Buffer.from('51', 'hex'),
            coinbaseTxInputNSequence: 0xffffffff,
            coinbaseTxOutputs: serializeCoinbaseOutputs([{
                address: 'tb1qdyjakeepue4trak9d3hvyelrd0aw7mwju2d0c2',
                amountSats: MockRecording1.BLOCK_TEMPLATE.coinbasevalue,
            }]),
            coinbaseTxLocktime: 0,
            merklePath: [],
        }));

        const errorFrame = sentFrames.find(frame => frame.msgType === Sv2MsgType.SET_CUSTOM_MINING_JOB_ERROR);
        const error = deserializeSetCustomMiningJobError(new BufferReader(errorFrame.payload));
        expect(error.channelId).toBe(1);
        expect(error.requestId).toBe(100);
        expect(error.errorCode).toBe('invalid-coinbase-payout-outputs');
    });

    it('rejects SetCustomMiningJob when work selection was not negotiated', async () => {
        const { client, sentFrames } = await createClient();
        await (client as any).handleOpenExtendedMiningChannel(serializeOpenExtendedMiningChannel({
            requestId: 1,
            userIdentity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
            minExtranonceSize: 8,
        }));

        sentFrames.length = 0;
        await (client as any).handleSetCustomMiningJob(serializeSetCustomMiningJob({
            channelId: 1,
            requestId: 100,
            token: Buffer.from('aa', 'hex'),
            version: MockRecording1.BLOCK_TEMPLATE.version,
            prevHash: Buffer.alloc(32, 1),
            minNtime: parseInt(MockRecording1.TIME, 16),
            nBits: parseInt(MockRecording1.BLOCK_TEMPLATE.bits, 16),
            coinbaseTxVersion: 2,
            coinbasePrefix: Buffer.from('51', 'hex'),
            coinbaseTxInputNSequence: 0xffffffff,
            coinbaseTxOutputs: Buffer.from('010000000000000000016a', 'hex'),
            coinbaseTxLocktime: 0,
            merklePath: [],
        }));

        const errorFrame = sentFrames.find(frame => frame.msgType === Sv2MsgType.SET_CUSTOM_MINING_JOB_ERROR);
        const error = deserializeSetCustomMiningJobError(new BufferReader(errorFrame.payload));
        expect(error.channelId).toBe(1);
        expect(error.requestId).toBe(100);
        expect(error.errorCode).toBe('work-selection-not-negotiated');
        expect((client as any).channels.get(1).extendedJobs.has(100)).toBe(false);
    });

    it('records accepted SV2 shares and persists DB hashrate', async () => {
        const { client, clientService, shareAccountingService, jobTemplate } = await createClient();
        (client as any).address = 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4';
        (client as any).workerName = 'worker';
        (client as any).sessionId = 'sv2-session';
        (client as any).userAgent = 'test/sv2';

        await (client as any).recordAcceptedShare(
            2048,
            1024,
            jobTemplate,
            null,
            {
                jobId: '1',
                nonce: 123,
                ntime: parseInt(MockRecording1.TIME, 16),
                version: jobTemplate.block.version,
                extraNonce2: 'c708000000000000',
            },
        );

        expect(shareAccountingService.recordAcceptedShare).toHaveBeenCalledWith(expect.objectContaining({
            protocol: 'sv2',
            address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
            clientName: 'worker',
            sessionId: 'sv2-session',
            jobId: '1',
            creditedDifficulty: 1024,
            submissionDifficulty: 2048,
            nonce: 123,
            extraNonce2: 'c708000000000000',
        }));
    });

    it('does not submit a block when only the reported SV2 difficulty is huge', async () => {
        const { client, shareAccountingService, bitcoinRpcService, blocksService, jobTemplate } = await createClient();
        (client as any).address = 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4';
        (client as any).workerName = 'worker';
        (client as any).sessionId = 'sv2-session';
        (client as any).userAgent = 'test/sv2';

        const job = new MiningJob(
            bitcoinjs.networks.testnet,
            '1',
            [{ address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', percent: 100 }],
            jobTemplate,
        );

        await (client as any).handleAcceptedShare(
            {
                nonce: 123,
                ntime: parseInt(MockRecording1.TIME, 16),
                version: jobTemplate.block.version,
            },
            { extranoncePrefix: Buffer.from(MockRecording1.EXTRA_NONCE, 'hex') },
            job,
            jobTemplate,
            Number.MAX_SAFE_INTEGER,
            1024,
            Buffer.alloc(32, 0xff),
        );

        expect(bitcoinRpcService.SUBMIT_BLOCK).not.toHaveBeenCalled();
        expect(blocksService.save).not.toHaveBeenCalled();
        expect(shareAccountingService.recordAcceptedShare).toHaveBeenCalledWith(expect.objectContaining({
            submissionDifficulty: Number.MAX_SAFE_INTEGER,
            isBlockCandidate: false,
        }));
    });

    it('submits a block when the SV2 hash target exactly meets network target', async () => {
        const { client, bitcoinRpcService, blocksService, notificationService, addressSettingsService, jobTemplate } = await createClient();
        bitcoinRpcService.SUBMIT_BLOCK.mockResolvedValue('SUCCESS!');
        (client as any).address = 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4';
        (client as any).workerName = 'worker';
        (client as any).sessionId = 'sv2-session';
        (client as any).userAgent = 'test/sv2';

        const job = new MiningJob(
            bitcoinjs.networks.testnet,
            '1',
            [{ address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', percent: 100 }],
            jobTemplate,
        );

        await (client as any).handleAcceptedShare(
            {
                nonce: 123,
                ntime: parseInt(MockRecording1.TIME, 16),
                version: jobTemplate.block.version,
            },
            { extranoncePrefix: Buffer.from(MockRecording1.EXTRA_NONCE, 'hex') },
            job,
            jobTemplate,
            1,
            1024,
            Buffer.alloc(32),
        );

        expect(bitcoinRpcService.SUBMIT_BLOCK).toHaveBeenCalledWith(expect.any(String));
        expect(blocksService.save).toHaveBeenCalledWith(expect.objectContaining({
            height: MockRecording1.BLOCK_TEMPLATE.height,
            minerAddress: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
            worker: 'worker',
            sessionId: 'sv2-session',
            blockData: expect.any(String),
            payoutSnapshotId: null,
            payoutMode: 'solo',
        }));
        expect(notificationService.notifySubscribersBlockFound).toHaveBeenCalled();
        expect(addressSettingsService.resetBestDifficultyAndShares).toHaveBeenCalled();
    });

    it('serializes queued canonical clean jobs in arrival order', async () => {
        const { client, jobTemplate } = await createClient();
        const firstTemplate = {
            ...jobTemplate,
            blockData: { ...jobTemplate.blockData, id: '100', clearJobs: true },
        };
        const secondTemplate = {
            ...jobTemplate,
            blockData: { ...jobTemplate.blockData, id: '101', clearJobs: true },
        };
        const operations: string[] = [];
        let releaseFirst: () => void;
        const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
        jest.spyOn(client as any, 'applyCanonicalJob').mockImplementation(async (template: any) => {
            operations.push(`start:${template.blockData.id}`);
            if (template.blockData.id === '100') {
                await firstGate;
            }
            operations.push(`end:${template.blockData.id}`);
        });

        const first = client.enqueueCanonicalJob(firstTemplate);
        const second = client.enqueueCanonicalJob(secondTemplate);
        await Promise.resolve();
        await Promise.resolve();

        expect(operations).toEqual(['start:100']);
        releaseFirst();
        await Promise.all([first, second]);
        expect(operations).toEqual(['start:100', 'end:100', 'start:101', 'end:101']);
    });

    it('collapses pending canonical work and prioritizes new-tip activation before its full job', async () => {
        const { client, jobTemplate } = await createClient();
        const activation = createActivationTemplate(jobTemplate);
        const firstTemplate = {
            ...jobTemplate,
            blockData: { ...jobTemplate.blockData, id: 'active-old-tip' },
        };
        const obsoleteTemplate = {
            ...jobTemplate,
            blockData: { ...jobTemplate.blockData, id: 'pending-old-tip' },
        };
        const fullTemplate = createCanonicalFollowup(jobTemplate, activation);
        const operations: string[] = [];
        let releaseFirst: () => void;
        const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
        jest.spyOn(client as any, 'applyCanonicalJob').mockImplementation(async (template: any) => {
            operations.push(`canonical:${template.blockData.id}`);
            if (template.blockData.id === 'active-old-tip') {
                await firstGate;
            }
        });
        jest.spyOn(client as any, 'applyWorkActivation').mockImplementation(async (template: any) => {
            operations.push(`activation:${template.height}:${template.previousblockhash}`);
        });

        const active = client.enqueueCanonicalJob(firstTemplate);
        const obsolete = client.enqueueCanonicalJob(obsoleteTemplate);
        const full = client.enqueueCanonicalJob(fullTemplate);
        const activate = client.enqueueWorkActivation(activation as any);

        expect((client as any).jobOperationQueue).toHaveLength(2);
        releaseFirst();
        await Promise.all([active, obsolete, full, activate]);

        expect(operations).toEqual([
            'canonical:active-old-tip',
            `activation:${activation.height}:${activation.previousblockhash}`,
            'canonical:canonical-followup',
        ]);
    });

    it('disconnects when non-coalescible SV2 operations exceed the queue bound', async () => {
        const { client } = await createClient();
        const unregisterClient = (client as any).stratumV2Service.unregisterClient as jest.Mock;
        (client as any).maxQueuedJobOperations = 2;
        let releaseActive: () => void;
        const activeGate = new Promise<void>(resolve => { releaseActive = resolve; });

        const active = (client as any).enqueueJobOperation(async () => activeGate);
        const first = (client as any).enqueueJobOperation(async () => undefined);
        const second = (client as any).enqueueJobOperation(async () => undefined);
        const overflow = (client as any).enqueueJobOperation(async () => undefined);

        expect((client as any).socket.destroyed).toBe(true);
        expect(unregisterClient).toHaveBeenCalledWith(client);
        expect((client as any).jobOperationQueue).toHaveLength(0);

        releaseActive();
        await Promise.all([active, first, second, overflow]);
    });

    it('filters canonical jobs by payout mode before queueing work', async () => {
        const { client, jobTemplate } = await createClient();
        const applySpy = jest.spyOn(client as any, 'applyCanonicalJob');
        const pplnsTemplate = {
            ...jobTemplate,
            blockData: { ...jobTemplate.blockData, payoutMode: 'pplns' },
        };

        await client.enqueueCanonicalJob(pplnsTemplate);

        expect(applySpy).not.toHaveBeenCalled();
    });

    it('does not send canonical work before channel-open success is written', async () => {
        const { client, sentFrames, jobTemplate } = await createClient();
        const latestTemplate = {
            ...jobTemplate,
            blockData: { ...jobTemplate.blockData, id: 'latest' },
        };
        (client as any).stratumV2Service.getLatestCanonicalJob = () => latestTemplate;
        let releaseOpen: () => void;
        const openGate = new Promise<void>(resolve => { releaseOpen = resolve; });
        (client as any).sendFrame.mockImplementation((msgType: number, payload: Buffer, extensionType = 0) => {
            sentFrames.push({ msgType, payload, extensionType });
            return msgType === Sv2MsgType.OPEN_EXTENDED_MINING_CHANNEL_SUCCESS
                ? openGate
                : Promise.resolve();
        });

        const opening = (client as any).handleOpenExtendedMiningChannel(serializeOpenExtendedMiningChannel({
            requestId: 1,
            userIdentity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
            minExtranonceSize: 8,
        }));
        await Promise.resolve();
        await Promise.resolve();

        await client.enqueueCanonicalJob(latestTemplate);
        expect(sentFrames.map(frame => frame.msgType)).toEqual([
            Sv2MsgType.OPEN_EXTENDED_MINING_CHANNEL_SUCCESS,
        ]);

        releaseOpen();
        await opening;
        expect(sentFrames.map(frame => frame.msgType)).toEqual([
            Sv2MsgType.OPEN_EXTENDED_MINING_CHANNEL_SUCCESS,
            Sv2MsgType.NEW_EXTENDED_MINING_JOB,
            Sv2MsgType.SET_NEW_PREV_HASH,
            Sv2MsgType.NEW_EXTENDED_MINING_JOB,
        ]);
    });

    it('sends the cached canonical job only to a newly opened second channel', async () => {
        const { client, sentFrames } = await createClient();
        const openMessage = (requestId: number) => serializeOpenExtendedMiningChannel({
            requestId,
            userIdentity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
            minExtranonceSize: 8,
        });
        await (client as any).handleOpenExtendedMiningChannel(openMessage(1));
        sentFrames.length = 0;

        await (client as any).handleOpenExtendedMiningChannel(openMessage(2));

        const jobs = sentFrames
            .filter(frame => frame.msgType === Sv2MsgType.NEW_EXTENDED_MINING_JOB)
            .map(frame => deserializeNewExtendedMiningJob(new BufferReader(frame.payload)));
        expect(jobs).toHaveLength(2);
        expect(jobs.every(job => job.channelId === 2)).toBe(true);
    });

    it('can force replacement work after a target change even when the template signature matches', async () => {
        const { client, sentFrames, jobTemplate } = await createClient();
        await (client as any).handleOpenExtendedMiningChannel(serializeOpenExtendedMiningChannel({
            requestId: 1,
            userIdentity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
            minExtranonceSize: 8,
        }));
        sentFrames.length = 0;

        await client.enqueueCanonicalJob(jobTemplate);
        expect(sentFrames).toHaveLength(0);

        await (client as any).applyCanonicalJob(jobTemplate, true);
        expect(sentFrames.some(frame => frame.msgType === Sv2MsgType.NEW_EXTENDED_MINING_JOB)).toBe(true);
        expect(sentFrames.some(frame => frame.msgType === Sv2MsgType.SET_NEW_PREV_HASH)).toBe(false);
    });

    it('activates a staged extended future with only SetNewPrevHash, then sends full same-tip work as active', async () => {
        const { client, sentFrames, jobTemplate } = await createClient();
        await (client as any).handleOpenExtendedMiningChannel(serializeOpenExtendedMiningChannel({
            requestId: 1,
            userIdentity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
            minExtranonceSize: 8,
        }));
        const future = deserializeNewExtendedMiningJob(new BufferReader(sentFrames
            .filter(frame => frame.msgType === Sv2MsgType.NEW_EXTENDED_MINING_JOB)
            .at(-1).payload));
        const activation = createActivationTemplate(jobTemplate);
        const channel = (client as any).channels.get(1);
        let boundBeforeWrite = false;
        sentFrames.length = 0;
        (client as any).sendFrame.mockImplementation((msgType: number, payload: Buffer, extensionType = 0) => {
            if (msgType === Sv2MsgType.SET_NEW_PREV_HASH) {
                const record = channel.extendedJobs.get(future.jobId);
                boundBeforeWrite = record.headerContext?.tipKey === `${activation.height}:${activation.previousblockhash}`;
            }
            sentFrames.push({ msgType, payload, extensionType });
            return Promise.resolve();
        });

        await client.enqueueWorkActivation(activation as any);

        expect(sentFrames.map(frame => frame.msgType)).toEqual([Sv2MsgType.SET_NEW_PREV_HASH]);
        const activated = deserializeSetNewPrevHash(new BufferReader(sentFrames[0].payload));
        expect(activated.jobId).toBe(future.jobId);
        expect(activated.prevHash).toEqual(Buffer.from(activation.previousblockhash, 'hex').reverse());
        expect(activated.nBits).toBe(parseInt(activation.bits, 16));
        expect(boundBeforeWrite).toBe(true);
        const activationContext = channel.extendedJobs.get(future.jobId).headerContext;

        sentFrames.length = 0;
        await client.enqueueCanonicalJob(createCanonicalFollowup(jobTemplate, activation));
        const followups = sentFrames
            .filter(frame => frame.msgType === Sv2MsgType.NEW_EXTENDED_MINING_JOB)
            .map(frame => deserializeNewExtendedMiningJob(new BufferReader(frame.payload)));
        expect(sentFrames.some(frame => frame.msgType === Sv2MsgType.SET_NEW_PREV_HASH)).toBe(false);
        expect(followups[0].minNtime).not.toBeNull();
        expect(followups.at(-1).minNtime).toBeNull();
        expect(channel.extendedJobs.get(future.jobId).retiredAt).toBeUndefined();
        const fullContext = channel.extendedJobs.get(followups[0].jobId).headerContext;
        expect(fullContext.activationMinNtime).toBe(activationContext.minNtime);
        expect(fullContext.activatedAtMonotonicNs).toBe(activationContext.activatedAtMonotonicNs);
        expect((client as any).isSubmissionHeaderValid(
            fullContext,
            fullContext.baseVersion,
            fullContext.minNtime,
        )).toBe(true);
        expect((client as any).isSubmissionHeaderValid(
            fullContext,
            fullContext.baseVersion,
            fullContext.minNtime + 1,
        )).toBe(true);
    });

    it('activates a staged standard future and rejects incompatible activation versions', async () => {
        const { client, sentFrames, jobTemplate } = await createClient();
        await (client as any).handleOpenStandardMiningChannel(serializeOpenStandardMiningChannel({
            requestId: 1,
            user_identity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
        }));
        const jobs = sentFrames
            .filter(frame => frame.msgType === Sv2MsgType.NEW_MINING_JOB)
            .map(frame => deserializeNewMiningJob(new BufferReader(frame.payload)));
        const future = jobs.at(-1);
        const activation = createActivationTemplate(jobTemplate);
        sentFrames.length = 0;

        await client.enqueueWorkActivation({ ...activation, height: activation.height + 1 } as any);
        expect(sentFrames).toHaveLength(0);
        await client.enqueueWorkActivation({ ...activation, version: activation.version ^ 1 } as any);
        expect(sentFrames).toHaveLength(0);
        expect((client as any).channels.get(1).stagedFutureJobId).toBe(future.jobId);

        await client.enqueueWorkActivation({ ...activation, version: activation.version ^ 0x2000 } as any);
        expect(sentFrames.map(frame => frame.msgType)).toEqual([Sv2MsgType.SET_NEW_PREV_HASH]);
        const activated = deserializeSetNewPrevHash(new BufferReader(sentFrames[0].payload));
        expect(activated.jobId).toBe(future.jobId);
        expect((client as any).channels.get(1).standardJobs.get(future.jobId).headerContext.nBits)
            .toBe(parseInt(activation.bits, 16));
    });

    it('validates fixed/rolling versions, required bits, and the advertised minimum nTime', async () => {
        const { client } = await createClient();
        const now = process.hrtime.bigint();
        const context = {
            tipKey: 'tip',
            prevHash: Buffer.alloc(32),
            nBits: 0x1d00ffff,
            minNtime: 100,
            height: 1,
            networkDifficulty: 1,
            baseVersion: 0x20000004,
            requiredVersionBits: 0x4,
            activatedAtMonotonicNs: now,
        };

        expect((client as any).isSubmissionHeaderValid(context, 0x20000004, 100)).toBe(true);
        expect((client as any).isSubmissionHeaderValid(context, 0x20002004, 100)).toBe(false);
        expect((client as any).isSubmissionHeaderValid(context, 0x20000004, 99)).toBe(false);
        expect((client as any).isSubmissionHeaderValid(context, 0x20000004, 101)).toBe(true);
        expect((client as any).isSubmissionHeaderValid(context, 0x20000004, 0xffffffff)).toBe(true);
        expect((client as any).isSubmissionHeaderValid(context, 0x20000004, 0x1_0000_0000)).toBe(false);

        (client as any).versionRollingEnabled = true;
        expect((client as any).isSubmissionHeaderValid(context, 0x20002004, 100)).toBe(true);
        expect((client as any).isSubmissionHeaderValid(context, 0x20000000, 100)).toBe(false);
        expect((client as any).isSubmissionHeaderValid(context, 0x20000005, 100)).toBe(false);

        const elapsedContext = {
            ...context,
            activatedAtMonotonicNs: now - 2_000_000_000n,
        };
        expect((client as any).isSubmissionHeaderValid(elapsedContext, 0x20000004, 10_000)).toBe(true);
    });

    it('binds canonical standard jobs to the SetNewPrevHash clock and reuses it for same-tip followups', async () => {
        const { client, sentFrames, jobTemplate } = await createClient();
        await (client as any).handleOpenStandardMiningChannel(serializeOpenStandardMiningChannel({
            requestId: 1,
            user_identity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
        }));
        const activation = deserializeSetNewPrevHash(new BufferReader(sentFrames
            .filter(frame => frame.msgType === Sv2MsgType.SET_NEW_PREV_HASH)
            .at(-1).payload));
        const channel = (client as any).channels.get(1);
        const initialContext = channel.standardJobs.get(activation.jobId).headerContext;
        expect(initialContext.activationMinNtime).toBe(activation.minNtime);
        expect(typeof initialContext.activatedAtMonotonicNs).toBe('bigint');

        sentFrames.length = 0;
        await (client as any).handleSubmitSharesStandard(serializeSubmitSharesStandard({
            channelId: 1,
            sequenceNumber: 1,
            jobId: activation.jobId,
            nonce: 0,
            ntime: activation.minNtime + 1,
            version: channel.standardJobs.get(activation.jobId).expectedVersion,
        }));
        const error = deserializeSubmitSharesError(new BufferReader(sentFrames
            .find(frame => frame.msgType === Sv2MsgType.SUBMIT_SHARES_ERROR).payload));
        expect(error.errorCode).toBe('difficulty-too-low');

        sentFrames.length = 0;
        const followup = {
            ...jobTemplate,
            block: Object.assign(new bitcoinjs.Block(), jobTemplate.block),
            blockData: {
                ...jobTemplate.blockData,
                id: 'same-tip-ntime-followup',
                clearJobs: false,
            },
        };
        await client.enqueueCanonicalJob(followup);
        const followupJob = deserializeNewMiningJob(new BufferReader(sentFrames
            .filter(frame => frame.msgType === Sv2MsgType.NEW_MINING_JOB)
            .at(-1).payload));
        const followupContext = channel.standardJobs.get(followupJob.jobId).headerContext;
        expect(followupJob.minNtime).not.toBeNull();
        expect(followupContext.activationMinNtime).toBe(initialContext.activationMinNtime);
        expect(followupContext.activatedAtMonotonicNs).toBe(initialContext.activatedAtMonotonicNs);
    });

    it('binds canonical extended jobs to the SetNewPrevHash clock', async () => {
        const { client, sentFrames } = await createClient();
        await (client as any).handleOpenExtendedMiningChannel(serializeOpenExtendedMiningChannel({
            requestId: 1,
            userIdentity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
            minExtranonceSize: 8,
        }));
        const activation = deserializeSetNewPrevHash(new BufferReader(sentFrames
            .filter(frame => frame.msgType === Sv2MsgType.SET_NEW_PREV_HASH)
            .at(-1).payload));
        const context = (client as any).channels.get(1).extendedJobs.get(activation.jobId).headerContext;
        expect(context.activationMinNtime).toBe(activation.minNtime);
        expect(typeof context.activatedAtMonotonicNs).toBe('bigint');
        expect((client as any).isSubmissionHeaderValid(
            context,
            context.baseVersion,
            activation.minNtime + 1,
        )).toBe(true);
    });

    it('updates only the queued future difficulty when SetTarget changes', async () => {
        const { client } = await createClient();
        await (client as any).handleOpenExtendedMiningChannel(serializeOpenExtendedMiningChannel({
            requestId: 1,
            userIdentity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
            minExtranonceSize: 8,
        }));
        const channel = (client as any).channels.get(1);
        const activeJobId = Array.from(channel.extendedJobs.entries())
            .find(([, job]: any) => job.headerContext != null)[0];
        const futureJobId = channel.stagedFutureJobId;
        const activeDifficulty = channel.jobIdToDifficulty.get(activeJobId);

        await (client as any).handleUpdateChannel(serializeUpdateChannel({
            channelId: 1,
            nominalHashRate: 1_000_000_000_000_000,
            maximumTarget: Buffer.alloc(32, 0xff),
        }));

        expect(channel.jobIdToDifficulty.get(activeJobId)).toBe(activeDifficulty);
        expect(channel.jobIdToDifficulty.get(futureJobId)).toBe(channel.sessionDifficulty);
        expect(channel.jobIdToDifficulty.get(futureJobId)).not.toBe(activeDifficulty);
    });

    it('expires superseded same-tip jobs while preserving active, latest, and staged future jobs', async () => {
        const { client, jobTemplate } = await createClient();
        await (client as any).handleOpenStandardMiningChannel(serializeOpenStandardMiningChannel({
            requestId: 1,
            user_identity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
        }));
        await (client as any).handleOpenExtendedMiningChannel(serializeOpenExtendedMiningChannel({
            requestId: 2,
            userIdentity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
            minExtranonceSize: 8,
        }));
        (client as any).jobRetentionMs = 1000;
        const channels = Array.from((client as any).channels.values()) as any[];
        const activeJobIds = channels.map(channel => channel.activePrevHashJobId);
        const futureJobIds = channels.map(channel => channel.stagedFutureJobId);
        const makeRefresh = (id: string) => ({
            ...jobTemplate,
            block: Object.assign(new bitcoinjs.Block(), jobTemplate.block),
            blockData: {
                ...jobTemplate.blockData,
                id,
                clearJobs: false,
            },
        });

        jest.advanceTimersByTime(100);
        await client.enqueueCanonicalJob(makeRefresh('same-tip-1'));
        const supersededIds = channels.map(channel => Math.max(...[
            ...channel.standardJobs.keys(),
            ...channel.extendedJobs.keys(),
        ]));

        jest.advanceTimersByTime(1100);
        await client.enqueueCanonicalJob(makeRefresh('same-tip-2'));

        channels.forEach((channel, index) => {
            const jobs = channel.channelType === 'standard'
                ? channel.standardJobs
                : channel.extendedJobs;
            expect(jobs.has(activeJobIds[index])).toBe(true);
            expect(jobs.has(futureJobIds[index])).toBe(true);
            expect(jobs.has(supersededIds[index])).toBe(false);
            expect(jobs.size).toBe(3);
            expect(channel.jobIdToDifficulty.size).toBe(jobs.size);
            if (channel.channelType === 'standard') {
                expect(channel.jobIdToMerkleRoot.size).toBe(jobs.size);
            }
        });
    });

    it('disconnects instead of evicting jobs still inside the candidate-rescue window', async () => {
        const { client, jobTemplate } = await createClient();
        await (client as any).handleOpenExtendedMiningChannel(serializeOpenExtendedMiningChannel({
            requestId: 1,
            userIdentity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
            minExtranonceSize: 8,
        }));
        (client as any).maxRetainedJobsPerChannel = 3;
        const makeRefresh = (id: string) => ({
            ...jobTemplate,
            block: Object.assign(new bitcoinjs.Block(), jobTemplate.block),
            blockData: {
                ...jobTemplate.blockData,
                id,
                clearJobs: false,
            },
        });

        await client.enqueueCanonicalJob(makeRefresh('within-retention-1'));
        expect((client as any).socket.destroyed).toBe(false);
        await client.enqueueCanonicalJob(makeRefresh('within-retention-2'));

        expect((client as any).socket.destroyed).toBe(true);
        expect((client as any).stratumV2Service.unregisterClient).toHaveBeenCalledWith(client);
    });

    it('accepts and accounts a successfully submitted stale extended candidate while rejecting ordinary stale shares', async () => {
        const { client, sentFrames, bitcoinRpcService, shareAccountingService } = await createClient();
        bitcoinRpcService.SUBMIT_BLOCK.mockResolvedValue('SUCCESS!');
        await (client as any).handleOpenExtendedMiningChannel(serializeOpenExtendedMiningChannel({
            requestId: 1,
            userIdentity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
            minExtranonceSize: 8,
        }));
        const activeJobId = deserializeSetNewPrevHash(new BufferReader(sentFrames
            .filter(frame => frame.msgType === Sv2MsgType.SET_NEW_PREV_HASH)
            .at(-1).payload)).jobId;
        const channel = (client as any).channels.get(1);
        channel.extendedJobs.get(activeJobId).retiredAt = Date.now();
        channel.activeTipKey = 'new-tip';
        jest.spyOn(DifficultyUtils, 'calculateDifficulty').mockReturnValue({
            submissionDifficulty: 1,
            submissionHash: '00'.repeat(32),
            hashBuffer: Buffer.alloc(32),
        });
        jest.spyOn(DifficultyUtils, 'meetsCompactTarget')
            .mockReturnValueOnce(true)
            .mockReturnValueOnce(false);
        sentFrames.length = 0;

        const submit = (nonce: number) => (client as any).handleSubmitSharesExtended(serializeSubmitSharesExtended({
            channelId: 1,
            sequenceNumber: nonce,
            jobId: activeJobId,
            nonce,
            ntime: parseInt(MockRecording1.TIME, 16),
            version: channel.extendedJobs.get(activeJobId).expectedVersion,
            extranonce: Buffer.alloc(channel.extranonceSize, 0x42),
        }));
        await submit(1);
        await submit(2);

        expect(bitcoinRpcService.SUBMIT_BLOCK).toHaveBeenCalledTimes(1);
        expect(shareAccountingService.recordAcceptedShare).toHaveBeenCalledTimes(1);
        expect(shareAccountingService.recordAcceptedShare).toHaveBeenCalledWith(expect.objectContaining({
            protocol: 'sv2',
            isBlockCandidate: true,
            blockSubmissionResult: 'SUCCESS!',
        }));
        const successes = sentFrames
            .filter(frame => frame.msgType === Sv2MsgType.SUBMIT_SHARES_SUCCESS)
            .map(frame => deserializeSubmitSharesSuccess(new BufferReader(frame.payload)));
        expect(successes).toHaveLength(1);
        expect(successes[0].lastSequenceNumber).toBe(1);
        const errors = sentFrames
            .filter(frame => frame.msgType === Sv2MsgType.SUBMIT_SHARES_ERROR)
            .map(frame => deserializeSubmitSharesError(new BufferReader(frame.payload)));
        expect(errors.map(error => error.errorCode)).toEqual(['stale-share']);

        (client as any).jobRetentionMs = 10;
        jest.advanceTimersByTime(11);
        (client as any).cleanupRetiredJobs(channel);
        expect(channel.extendedJobs.has(activeJobId)).toBe(false);
        expect(channel.jobIdToDifficulty.has(activeJobId)).toBe(false);
    });

    it('accepts and accounts a successfully submitted stale standard candidate', async () => {
        const { client, sentFrames, bitcoinRpcService, shareAccountingService } = await createClient();
        bitcoinRpcService.SUBMIT_BLOCK.mockResolvedValue('SUCCESS!');
        await (client as any).handleOpenStandardMiningChannel(serializeOpenStandardMiningChannel({
            requestId: 1,
            user_identity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
        }));
        const activeJobId = deserializeSetNewPrevHash(new BufferReader(sentFrames
            .filter(frame => frame.msgType === Sv2MsgType.SET_NEW_PREV_HASH)
            .at(-1).payload)).jobId;
        const channel = (client as any).channels.get(1);
        const staleJob = channel.standardJobs.get(activeJobId);
        staleJob.retiredAt = Date.now();
        channel.activeTipKey = 'new-tip';
        jest.spyOn(DifficultyUtils, 'calculateDifficulty').mockReturnValue({
            submissionDifficulty: 1,
            submissionHash: '00'.repeat(32),
            hashBuffer: Buffer.alloc(32),
        });
        jest.spyOn(DifficultyUtils, 'meetsCompactTarget').mockReturnValue(true);
        sentFrames.length = 0;

        await (client as any).handleSubmitSharesStandard(serializeSubmitSharesStandard({
            channelId: 1,
            sequenceNumber: 7,
            jobId: activeJobId,
            nonce: 1,
            ntime: parseInt(MockRecording1.TIME, 16),
            version: staleJob.expectedVersion,
        }));

        expect(bitcoinRpcService.SUBMIT_BLOCK).toHaveBeenCalledTimes(1);
        expect(shareAccountingService.recordAcceptedShare).toHaveBeenCalledWith(expect.objectContaining({
            protocol: 'sv2',
            isBlockCandidate: true,
            blockSubmissionResult: 'SUCCESS!',
        }));
        const successFrame = sentFrames.find(frame => frame.msgType === Sv2MsgType.SUBMIT_SHARES_SUCCESS);
        expect(deserializeSubmitSharesSuccess(new BufferReader(successFrame.payload)).lastSequenceNumber).toBe(7);
        expect(sentFrames.some(frame => frame.msgType === Sv2MsgType.SUBMIT_SHARES_ERROR)).toBe(false);
    });

    it('keeps a rejected stale block candidate on the stale-share error path', async () => {
        const { client, sentFrames, bitcoinRpcService, shareAccountingService } = await createClient();
        bitcoinRpcService.SUBMIT_BLOCK.mockResolvedValue('stale-prevblk');
        await (client as any).handleOpenExtendedMiningChannel(serializeOpenExtendedMiningChannel({
            requestId: 1,
            userIdentity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
            minExtranonceSize: 8,
        }));
        const activeJobId = deserializeSetNewPrevHash(new BufferReader(sentFrames
            .filter(frame => frame.msgType === Sv2MsgType.SET_NEW_PREV_HASH)
            .at(-1).payload)).jobId;
        const channel = (client as any).channels.get(1);
        const staleJob = channel.extendedJobs.get(activeJobId);
        staleJob.retiredAt = Date.now();
        channel.activeTipKey = 'new-tip';
        jest.spyOn(DifficultyUtils, 'calculateDifficulty').mockReturnValue({
            submissionDifficulty: 1,
            submissionHash: '00'.repeat(32),
            hashBuffer: Buffer.alloc(32),
        });
        jest.spyOn(DifficultyUtils, 'meetsCompactTarget').mockReturnValue(true);
        sentFrames.length = 0;

        await (client as any).handleSubmitSharesExtended(serializeSubmitSharesExtended({
            channelId: 1,
            sequenceNumber: 9,
            jobId: activeJobId,
            nonce: 1,
            ntime: parseInt(MockRecording1.TIME, 16),
            version: staleJob.expectedVersion,
            extranonce: Buffer.alloc(channel.extranonceSize, 0x42),
        }));

        expect(bitcoinRpcService.SUBMIT_BLOCK).toHaveBeenCalledTimes(1);
        expect(shareAccountingService.recordAcceptedShare).not.toHaveBeenCalled();
        const errorFrame = sentFrames.find(frame => frame.msgType === Sv2MsgType.SUBMIT_SHARES_ERROR);
        expect(deserializeSubmitSharesError(new BufferReader(errorFrame.payload)).errorCode)
            .toBe('stale-share');
        expect(sentFrames.some(frame => frame.msgType === Sv2MsgType.SUBMIT_SHARES_SUCCESS)).toBe(false);
    });

    it('orders channel target mutations and SetTarget after already-queued canonical work', async () => {
        const { client, jobTemplate } = await createClient();
        await (client as any).handleOpenExtendedMiningChannel(serializeOpenExtendedMiningChannel({
            requestId: 1,
            userIdentity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
            minExtranonceSize: 8,
        }));
        const channel = (client as any).channels.get(1);
        const originalDifficulty = channel.sessionDifficulty;
        const operations: string[] = [];
        let releaseJob: () => void;
        const jobGate = new Promise<void>(resolve => { releaseJob = resolve; });
        jest.spyOn(client as any, 'sendNewExtendedMiningJob').mockImplementation(async () => {
            operations.push(`job:${channel.sessionDifficulty}`);
            await jobGate;
        });
        jest.spyOn(client as any, 'sendSetTarget').mockImplementation(async () => {
            operations.push(`target:${channel.sessionDifficulty}`);
        });
        const nextTemplate = {
            ...jobTemplate,
            blockData: { ...jobTemplate.blockData, id: 'next' },
        };

        const canonicalJob = client.enqueueCanonicalJob(nextTemplate);
        await Promise.resolve();
        await Promise.resolve();
        const targetUpdate = (client as any).handleUpdateChannel(serializeUpdateChannel({
            channelId: 1,
            nominalHashRate: 1_000_000_000_000_000,
            maximumTarget: Buffer.alloc(32, 0xff),
        }));

        expect(channel.sessionDifficulty).toBe(originalDifficulty);
        expect(operations).toEqual([`job:${originalDifficulty}`]);

        releaseJob();
        await Promise.all([canonicalJob, targetUpdate]);
        expect(channel.sessionDifficulty).not.toBe(originalDifficulty);
        expect(operations).toEqual([
            `job:${originalDifficulty}`,
            `target:${channel.sessionDifficulty}`,
        ]);
    });

    it('closes and unregisters a client when its queued job fails', async () => {
        const { client, jobTemplate } = await createClient();
        const unregisterClient = (client as any).stratumV2Service.unregisterClient as jest.Mock;
        jest.spyOn(client as any, 'applyCanonicalJob').mockRejectedValue(new Error('write failed'));

        await client.enqueueCanonicalJob(jobTemplate);

        expect((client as any).socket.destroyed).toBe(true);
        expect(unregisterClient).toHaveBeenCalledWith(client);
    });

    it('bounds outstanding SV2 socket bytes across unresolved write callbacks', async () => {
        const { client } = await createClient();
        const socket = (client as any).socket;
        (client as any).maxSocketBufferBytes = 8;
        let finishFirstWrite: (error?: Error) => void;
        socket.write.mockImplementation((_data: Buffer, callback: (error?: Error) => void) => {
            finishFirstWrite = callback;
            return false;
        });

        const firstWrite = (client as any).writeRaw(Buffer.alloc(5));
        await expect((client as any).writeRaw(Buffer.alloc(4)))
            .rejects.toThrow('SV2 socket buffer would reach 9 bytes');

        expect(socket.destroyed).toBe(true);
        finishFirstWrite();
        await firstWrite;
    });

    it('disconnects when an SV2 socket write callback never completes', async () => {
        const { client } = await createClient();
        const socket = (client as any).socket;
        (client as any).socketWriteTimeoutMs = 25;
        socket.write.mockImplementation(() => false);

        const write = (client as any).writeRaw(Buffer.alloc(1));
        jest.advanceTimersByTime(26);

        await expect(write).rejects.toThrow('SV2 socket write callback exceeded 25ms');
        expect(socket.destroyed).toBe(true);
        expect((client as any).stratumV2Service.unregisterClient).toHaveBeenCalledWith(client);
    });

    it('releases shared extranonce allocations for standard and extended channels', async () => {
        const { client } = await createClient();
        await (client as any).handleOpenStandardMiningChannel(serializeOpenStandardMiningChannel({
            requestId: 1,
            user_identity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
        }));
        await (client as any).handleOpenExtendedMiningChannel(serializeOpenExtendedMiningChannel({
            requestId: 2,
            userIdentity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
            minExtranonceSize: 8,
        }));
        const release = (client as any).stratumV2Service.releaseExtranoncePrefix as jest.Mock;

        (client as any).handleCloseChannel(serializeCloseChannel({
            channelId: 1,
            reasonCode: 'test-close',
        }));
        expect(release).toHaveBeenCalledWith(1);

        await client.destroy();
        expect(release).toHaveBeenCalledWith(2);
        expect(release).toHaveBeenCalledTimes(2);
    });

    it('unregisters from the centralized broadcaster exactly once on destroy', async () => {
        const { client } = await createClient();
        const unregisterClient = (client as any).stratumV2Service.unregisterClient as jest.Mock;

        await client.destroy();
        await client.destroy();

        expect(unregisterClient).toHaveBeenCalledTimes(1);
        expect(unregisterClient).toHaveBeenCalledWith(client);
    });

    async function createClient(payoutMode: 'solo' | 'pplns' = 'solo'): Promise<{
        client: StratumV2Client;
        sentFrames: any[];
        bitcoinRpcService: { SUBMIT_BLOCK: jest.Mock };
        clientService: { updateHashRate: jest.Mock };
        blocksService: { save: jest.Mock };
        notificationService: { notifySubscribersBlockFound: jest.Mock };
        addressSettingsService: { resetBestDifficultyAndShares: jest.Mock; updateBestDifficultyIfHigher: jest.Mock };
        shareAccountingService: { recordAcceptedShare: jest.Mock };
        redisMessagingService: Record<string, never>;
        jobTemplate: any;
    }> {
        const blockTemplate$ = new BehaviorSubject(MockRecording1.BLOCK_TEMPLATE);
        const bitcoinRpcService = {
            newBlockTemplate$: blockTemplate$.asObservable(),
            miningInfo: { blocks: MockRecording1.BLOCK_TEMPLATE.height },
            SUBMIT_BLOCK: jest.fn().mockResolvedValue(null),
        };
        const stratumV1JobsService = new StratumV1JobsService(bitcoinRpcService as any);
        const jobTemplate = await firstValueFrom(stratumV1JobsService.newMiningJob$);

        const mockSocket: any = {
            destroyed: false,
            writableEnded: false,
            on: jest.fn().mockReturnThis(),
            write: jest.fn((data, callback) => {
                callback?.();
                return true;
            }),
            destroy: jest.fn(function destroy() {
                mockSocket.destroyed = true;
                return mockSocket;
            }),
        };
        const socket = mockSocket as Socket;

        const clientEntity = {
            id: 1,
            sessionId: 'sv2-session',
            address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
            clientName: 'worker',
            userAgent: 'test/sv2',
            startTime: new Date(),
            bestDifficulty: 0,
        } as unknown as ClientEntity;

        let nextChannelId = 1;
        const sentFrames: any[] = [];
        const clientService = {
            insert: jest.fn().mockResolvedValue(clientEntity),
            delete: jest.fn().mockResolvedValue(undefined),
            updateBestDifficultyIfHigher: jest.fn().mockResolvedValue(undefined),
            updateHashRate: jest.fn().mockResolvedValue(undefined),
        };
        const shareAccountingService = {
            recordAcceptedShare: jest.fn().mockResolvedValue(undefined),
        };
        const notificationService = {
            notifySubscribersBlockFound: jest.fn().mockResolvedValue(undefined),
        };
        const blocksService = {
            save: jest.fn().mockResolvedValue(undefined),
        };
        const redisMessagingService = {};
        const addressSettingsService = {
            resetBestDifficultyAndShares: jest.fn().mockResolvedValue(undefined),
            updateBestDifficultyIfHigher: jest.fn().mockResolvedValue(undefined),
        };
        const client = new StratumV2Client(
            socket,
            Buffer.alloc(0),
            {
                getNoiseConfig: () => ({
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
                }),
                getNextChannelId: () => nextChannelId++,
                generateExtranoncePrefix: (_channelId: number) => Buffer.from('00000002', 'hex'),
                allocateExtendedExtranoncePrefix: jest.fn(() => Buffer.from('00000001', 'hex')),
                releaseExtranoncePrefix: jest.fn(),
                releaseExtendedExtranoncePrefix: jest.fn(),
                getExtendedMinerExtranonceSize: () => 10,
                getExtendedTotalExtranonceSize: () => 14,
                getLatestCanonicalJob: () => jobTemplate,
                unregisterClient: jest.fn(),
            } as any,
            stratumV1JobsService,
            bitcoinRpcService as any,
            clientService as any,
            notificationService as any,
            blocksService as any,
            {
                get: jest.fn((key: string) => {
                    switch (key) {
                        case 'NETWORK':
                            return 'testnet';
                        case 'SV2_START_DIFFICULTY':
                            return '1';
                        default:
                            return null;
                    }
                }),
            } as unknown as ConfigService,
            addressSettingsService as any,
            new CustomWorkService(),
            {
                hasKnownToken: jest.fn().mockReturnValue(true),
                getDeclaredJob: jest.fn().mockReturnValue({
                    validationMode: 'full_template',
                    job: { version: MockRecording1.BLOCK_TEMPLATE.version },
                }),
            } as any,
            shareAccountingService as any,
            redisMessagingService as any,
            undefined,
            payoutMode,
        );
        (client as any).sendFrame = jest.fn((msgType: number, payload: Buffer, extensionType = 0) => {
            sentFrames.push({ msgType, payload, extensionType });
            return Promise.resolve();
        });

        return {
            client,
            sentFrames,
            bitcoinRpcService,
            clientService,
            blocksService,
            notificationService,
            addressSettingsService,
            shareAccountingService,
            redisMessagingService,
            jobTemplate,
        };
    }
});

function serializeCoinbaseOutputs(outputs: { address: string; amountSats: number }[]): Buffer {
    return Buffer.concat([
        Buffer.from([outputs.length]),
        ...outputs.map(output => {
            const script = bitcoinjs.address.toOutputScript(output.address, bitcoinjs.networks.testnet);
            const value = Buffer.alloc(8);
            value.writeBigUInt64LE(BigInt(output.amountSats), 0);
            return Buffer.concat([
                value,
                Buffer.from([script.length]),
                script,
            ]);
        }),
    ]);
}

function createActivationTemplate(jobTemplate: any) {
    return {
        ...MockRecording1.BLOCK_TEMPLATE,
        height: jobTemplate.blockData.height + 1,
        previousblockhash: '11'.repeat(32),
        version: jobTemplate.block.version,
        vbrequired: 0,
        bits: MockRecording1.BLOCK_TEMPLATE.bits,
        mintime: parseInt(MockRecording1.TIME, 16) + 1,
        curtime: parseInt(MockRecording1.TIME, 16) + 1,
        transactions: [],
        jobType: 'empty' as const,
        payoutMode: 'solo' as const,
    };
}

function createCanonicalFollowup(jobTemplate: any, activation: any) {
    const block = Object.assign(new bitcoinjs.Block(), jobTemplate.block, {
        prevHash: Buffer.from(activation.previousblockhash, 'hex').reverse(),
        bits: parseInt(activation.bits, 16),
        timestamp: activation.mintime + 1,
        version: activation.version,
    });
    block.transactions = jobTemplate.block.transactions.map((transaction: bitcoinjs.Transaction) =>
        Object.assign(new bitcoinjs.Transaction(), transaction));
    return {
        ...jobTemplate,
        block,
        blockData: {
            ...jobTemplate.blockData,
            id: 'canonical-followup',
            height: activation.height,
            tipKey: `${activation.height}:${activation.previousblockhash}`,
            clearJobs: true,
            isNewBlock: true,
            jobType: 'full' as const,
            payoutMode: 'solo' as const,
        },
    };
}
