import { ConfigService } from '@nestjs/config';
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

    async function createClient(): Promise<{ client: StratumV2Client; sentFrames: any[] }> {
        const blockTemplate$ = new BehaviorSubject(MockRecording1.BLOCK_TEMPLATE);
        const bitcoinRpcService = {
            newBlockTemplate$: blockTemplate$.asObservable(),
            miningInfo: { blocks: MockRecording1.BLOCK_TEMPLATE.height },
            SUBMIT_BLOCK: jest.fn().mockResolvedValue(null),
        };
        const stratumV1JobsService = new StratumV1JobsService(bitcoinRpcService as any);
        await firstValueFrom(stratumV1JobsService.newMiningJob$);

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
            bestDifficulty: 0,
        } as unknown as ClientEntity;

        let nextChannelId = 1;
        const sentFrames: any[] = [];
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
            {
                insert: jest.fn().mockResolvedValue(clientEntity),
                delete: jest.fn().mockResolvedValue(undefined),
                heartbeatBulkAsync: jest.fn(),
                updateBestDifficultyIfHigher: jest.fn().mockResolvedValue(undefined),
            } as any,
            {
                insert: jest.fn().mockResolvedValue(undefined),
                updateBulkAsync: jest.fn(),
            } as any,
            { notifySubscribersBlockFound: jest.fn().mockResolvedValue(undefined) } as any,
            { save: jest.fn().mockResolvedValue(undefined) } as any,
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
        );
        (client as any).sendFrame = jest.fn((msgType: number, payload: Buffer, extensionType = 0) => {
            sentFrames.push({ msgType, payload, extensionType });
            return Promise.resolve();
        });

        return { client, sentFrames };
    }
});
