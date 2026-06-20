import { ConfigService } from '@nestjs/config';
import * as bitcoinjs from 'bitcoinjs-lib';
import { Socket } from 'net';
import { BehaviorSubject, firstValueFrom } from 'rxjs';

import { MockRecording1 } from '../../test/models/MockRecording1';
import { ClientEntity } from '../ORM/client/client.entity';
import { CustomWorkService } from '../services/custom-work.service';
import { StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { hash256 } from '../utils/hash.utils';
import { BufferReader } from './sv2/sv2-binary-codec';
import { SV2_CHANNEL_MSG_FLAG, Sv2MiningSetupFlags, Sv2MsgType, Sv2Protocol } from './sv2/sv2-constants';
import {
    deserializeOpenExtendedMiningChannelSuccess,
    deserializeNewExtendedMiningJob,
    serializeOpenExtendedMiningChannel,
    serializeSubmitSharesExtended,
} from './sv2/sv2-extended-messages';
import { deserializeSetNewPrevHash, deserializeSubmitSharesError, serializeSetupConnection } from './sv2/sv2-messages';
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
        const jobFrame = jobFrames[jobFrames.length - 1];
        const prevHashFrames = sentFrames.filter(frame => frame.msgType === Sv2MsgType.SET_NEW_PREV_HASH);
        const prevHashFrame = prevHashFrames[prevHashFrames.length - 1];

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
        const prevHash = deserializeSetNewPrevHash(new BufferReader(prevHashFrame.payload));
        expect(prevHash.channelId).toBe(1);
        expect(prevHash.jobId).toBe(job.jobId);
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

    it('reconstructs extended-channel block candidates with a matching merkle root', async () => {
        const { client, sentFrames } = await createClient();
        await (client as any).handleOpenExtendedMiningChannel(serializeOpenExtendedMiningChannel({
            requestId: 1,
            userIdentity: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker',
            nominalHashRate: 0,
            maxTarget: Buffer.alloc(32, 0xff),
            minExtranonceSize: 8,
        }));
        const jobFrame = sentFrames
            .filter(frame => frame.msgType === Sv2MsgType.NEW_EXTENDED_MINING_JOB)
            .at(-1);
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
        expect(block.transactions[0].toBuffer()).toEqual(coinbaseTxBytes);
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
        expect((client as any).channels.get(1).extendedJobs.get(success.jobId).workProtocol).toBe('sv2_jdp');
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

    it('records accepted SV2 shares before presence updates', async () => {
        const { client, shareAccountingService, redisMessagingService, jobTemplate } = await createClient();
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
        const accountingCallOrder = shareAccountingService.recordAcceptedShare.mock.invocationCallOrder[0];
        const postAccountingPresenceUpdates = redisMessagingService.setClientPresence.mock.invocationCallOrder
            .filter(callOrder => callOrder > accountingCallOrder);
        expect(postAccountingPresenceUpdates.length).toBeGreaterThan(0);
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

    async function createClient(): Promise<{
        client: StratumV2Client;
        sentFrames: any[];
        bitcoinRpcService: { SUBMIT_BLOCK: jest.Mock };
        blocksService: { save: jest.Mock };
        notificationService: { notifySubscribersBlockFound: jest.Mock };
        addressSettingsService: { resetBestDifficultyAndShares: jest.Mock; updateBestDifficultyIfHigher: jest.Mock };
        shareAccountingService: { recordAcceptedShare: jest.Mock };
        redisMessagingService: { setClientPresence: jest.Mock; removeClientPresence: jest.Mock };
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
        const redisMessagingService = {
            setClientPresence: jest.fn().mockResolvedValue(undefined),
            removeClientPresence: jest.fn().mockResolvedValue(undefined),
        };
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
                generateExtranoncePrefix: () => Buffer.from('00000002', 'hex'),
                allocateExtendedExtranoncePrefix: jest.fn(() => Buffer.from('00000001', 'hex')),
                releaseExtendedExtranoncePrefix: jest.fn(),
                getExtendedMinerExtranonceSize: () => 10,
                getExtendedTotalExtranonceSize: () => 14,
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
        );
        (client as any).sendFrame = jest.fn((msgType: number, payload: Buffer, extensionType = 0) => {
            sentFrames.push({ msgType, payload, extensionType });
            return Promise.resolve();
        });

        return {
            client,
            sentFrames,
            bitcoinRpcService,
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
