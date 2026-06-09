import { ConfigService } from '@nestjs/config';
import * as bitcoinjs from 'bitcoinjs-lib';
import { Socket } from 'net';
import { BehaviorSubject, firstValueFrom } from 'rxjs';

import { MockRecording1 } from '../../test/models/MockRecording1';
import { ClientEntity } from '../ORM/client/client.entity';
import { StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { BufferReader } from './sv2/sv2-binary-codec';
import { SV2_CHANNEL_MSG_FLAG, Sv2MsgType } from './sv2/sv2-constants';
import {
    deserializeOpenExtendedMiningChannelSuccess,
    deserializeNewExtendedMiningJob,
    serializeOpenExtendedMiningChannel,
    serializeSubmitSharesExtended,
} from './sv2/sv2-extended-messages';
import { deserializeSetNewPrevHash, deserializeSubmitSharesError } from './sv2/sv2-messages';
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
        expect(success.extranonceSize).toBe(8);
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
        const { client, bitcoinRpcService, blocksService, notificationService, jobTemplate } = await createClient();
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
        }));
        expect(notificationService.notifySubscribersBlockFound).toHaveBeenCalled();
    });

    async function createClient(): Promise<{
        client: StratumV2Client;
        sentFrames: any[];
        bitcoinRpcService: { SUBMIT_BLOCK: jest.Mock };
        blocksService: { save: jest.Mock };
        notificationService: { notifySubscribersBlockFound: jest.Mock };
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
                getExtendedMinerExtranonceSize: () => 8,
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
            {
                resetBestDifficultyAndShares: jest.fn().mockResolvedValue(undefined),
                updateBestDifficultyIfHigher: jest.fn().mockResolvedValue(undefined),
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
            shareAccountingService,
            redisMessagingService,
            jobTemplate,
        };
    }
});
