import { ConfigService } from '@nestjs/config';
import * as bitcoinjs from 'bitcoinjs-lib';
import { Socket } from 'net';
import { BehaviorSubject, firstValueFrom } from 'rxjs';

import { MockRecording1 } from '../../test/models/MockRecording1';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService as MockBitcoinRpcService } from '../services/bitcoin-rpc.service';
import { NotificationService } from '../services/notification.service';
import { StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { DifficultyUtils } from '../utils/difficulty.utils';
import { IBlockTemplate } from './bitcoin-rpc/IBlockTemplate';
import { MiningJob } from './MiningJob';
import { StratumV1Client } from './StratumV1Client';
import { MiningSubmitMessage } from './stratum-messages/MiningSubmitMessage';





jest.mock('../services/bitcoin-rpc.service')

jest.mock('./validators/bitcoin-address.validator', () => ({
    IsBitcoinAddress() {
        return jest.fn();
    },
}));


describe('StratumV1Client', () => {


    let socket: Socket;
    let stratumV1JobsService: StratumV1JobsService;
    let bitcoinRpcService: MockBitcoinRpcService;

    let clientService: ClientService;
    let notificationService: NotificationService;
    let blocksService: BlocksService;
    let configService: ConfigService;
    let addressSettings: AddressSettingsService;
    let shareAccountingService: { recordAcceptedShare: jest.Mock };
    let redisMessagingService: Record<string, never>;

    let client: StratumV1Client;

    let socketEmitter: (...args: any[]) => void;
    const emitMessage = (message: string) => socketEmitter(Buffer.from(`${message}\n`));
    let consoleLogSpy: jest.SpyInstance;
    let consoleErrorSpy: jest.SpyInstance;
    let consoleWarnSpy: jest.SpyInstance;

    let newBlockEmitter: BehaviorSubject<IBlockTemplate>;

    beforeEach(async () => {

        jest.useFakeTimers({ advanceTimers: true })
        jest.setSystemTime(new Date(parseInt(MockRecording1.TIME, 16) * 1000));
        consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        newBlockEmitter = new BehaviorSubject(MockRecording1.BLOCK_TEMPLATE);

        const clients = new Map<string, any>();
        let nextClientId = 1;
        clientService = {
            insert: jest.fn(async (partialClient) => {
                const clientEntity = {
                    id: `00000000-0000-4000-8000-${String(nextClientId++).padStart(12, '0')}`,
                    hashRate: 0,
                    updatedAt: new Date(),
                    deletedAt: null,
                    ...partialClient,
                };
                clients.set(clientEntity.id, clientEntity);
                return clientEntity;
            }),
            delete: jest.fn(async (id: string) => {
                clients.delete(id);
            }),
            connectedClientCount: jest.fn(async () => clients.size),
            updateBestDifficultyIfHigher: jest.fn().mockResolvedValue({ affected: 1 }),
            updateHashRate: jest.fn().mockResolvedValue(undefined),
        } as any;

        configService = {
            get: jest.fn((key: string) => {
                switch (key) {
                    case 'DEV_FEE_ADDRESS':
                        return 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4';
                    case 'NETWORK':
                        return 'testnet';
                }
                return null;
            })
        } as any;
        (StratumV1Client as any).blockedUserAgentLogState.clear();
        (StratumV1Client as any).validationErrorLogState.clear();

        bitcoinRpcService = {
            newBlockTemplate$: newBlockEmitter.asObservable(),
            miningInfo: { blocks: MockRecording1.BLOCK_TEMPLATE.height },
            SUBMIT_BLOCK: jest.fn().mockResolvedValue(null)
        } as any;


        stratumV1JobsService = new StratumV1JobsService(bitcoinRpcService);

        socket = new Socket();
        // jest.spyOn(socket, 'on').mockImplementation((event: string, fn: (data: Buffer) => void) => {
        //     socketEmitter = fn;
        // });

        jest.spyOn(socket, 'on').mockImplementation((event: string, listener: (...args: any[]) => void) => {
            socketEmitter = listener;
            return socket;
        });

        socket.end = jest.fn();
        jest.spyOn(socket, 'destroy').mockImplementation(() => socket);

        addressSettings = {
            getSettings: jest.fn().mockResolvedValue(null),
            updateBestDifficultyIfHigher: jest.fn().mockResolvedValue({ affected: 1 }),
            resetBestDifficultyAndShares: jest.fn().mockResolvedValue(undefined),
        } as any;
        notificationService = {
            notifySubscribersBlockFound: jest.fn().mockResolvedValue(undefined)
        } as any;
        blocksService = {
            save: jest.fn().mockResolvedValue(undefined)
        } as any;
        shareAccountingService = {
            recordAcceptedShare: jest.fn().mockResolvedValue(undefined),
        };
        redisMessagingService = {};


        client = new StratumV1Client(
            socket,
            stratumV1JobsService,
            bitcoinRpcService,
            clientService,
            notificationService,
            blocksService,
            configService,
            addressSettings,
            shareAccountingService as any,
            redisMessagingService as any
        );

        client.extraNonceAndSessionId = MockRecording1.EXTRA_NONCE;
        jest.spyOn(client as any, 'getRandomHexString').mockReturnValue(MockRecording1.EXTRA_NONCE);

    });

    afterEach(async () => {
        client.destroy();
        consoleLogSpy.mockRestore();
        consoleErrorSpy.mockRestore();
        consoleWarnSpy.mockRestore();
        jest.useRealTimers();
    })


    it('should subscribe to socket', () => {
        expect(socket.on).toHaveBeenCalled();
    });

    it('disconnects when an unterminated inbound message exceeds the configured limit', async () => {
        (configService.get as jest.Mock).mockImplementation((key: string) => {
            if (key === 'STRATUM_MAX_INBOUND_LINE_BYTES') return '16';
            if (key === 'NETWORK') return 'testnet';
            return null;
        });
        client = new StratumV1Client(
            socket,
            stratumV1JobsService,
            bitcoinRpcService,
            clientService,
            notificationService,
            blocksService,
            configService,
            addressSettings,
            shareAccountingService as any,
            redisMessagingService as any,
        );

        socketEmitter(Buffer.from('x'.repeat(17)));
        await Promise.resolve();

        expect(socket.destroy).toHaveBeenCalled();
        expect((client as any).buffer).toBe('');
    });

    it('accepts multiple complete messages when each line is within the inbound limit', async () => {
        (configService.get as jest.Mock).mockImplementation((key: string) => {
            if (key === 'STRATUM_MAX_INBOUND_LINE_BYTES') return '64';
            if (key === 'NETWORK') return 'testnet';
            return null;
        });
        client = new StratumV1Client(
            socket,
            stratumV1JobsService,
            bitcoinRpcService,
            clientService,
            notificationService,
            blocksService,
            configService,
            addressSettings,
            shareAccountingService as any,
            redisMessagingService as any,
        );
        jest.spyOn(client as any, 'handleMessage').mockResolvedValue(undefined);

        socketEmitter(Buffer.from('{"id":1}\n{"id":2}\n'));
        await Promise.resolve();

        expect((client as any).handleMessage).toHaveBeenCalledTimes(2);
        expect(socket.destroy).not.toHaveBeenCalled();
    });

    it('should clean up socket state only once when destroyed repeatedly', async () => {
        const timer = setInterval(() => undefined, 1000);
        const removeListenerSpy = jest.spyOn(socket, 'removeListener');

        (client as any).clientEntity = {
            id: '00000000-0000-4000-8000-000000000001',
            address: 'tb1qcleanup',
        };
        (client as any).backgroundWork = [timer];
        (client as any).miningSubmissionHashes.set('submitted-share', Date.now() + 1000);
        (client as any).buffer = 'partial-message';

        await Promise.all([client.destroy(), client.destroy()]);

        expect(clientService.delete).toHaveBeenCalledTimes(1);
        expect(clientService.delete).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001');
        expect(removeListenerSpy).toHaveBeenCalledWith('data', expect.any(Function));
        expect((client as any).backgroundWork).toEqual([]);
        expect((client as any).miningSubmissionHashes.size).toBe(0);
        expect((client as any).buffer).toBe('');
    });

    it('should close socket on invalid JSON', () => {
        emitMessage('INVALID');
        jest.spyOn(socket, 'destroy');
        expect(socket.on).toHaveBeenCalled();
    });

    it('should respond to mining.subscribe', async () => {
        jest.spyOn(socket, 'write').mockImplementation((data) => true);

        expect(socket.on).toHaveBeenCalled();
        emitMessage(MockRecording1.MINING_SUBSCRIBE);

        await new Promise((r) => setTimeout(r, 1));

        expect(socket.write).toHaveBeenCalledWith(`{"id":1,"error":null,"result":[[["mining.notify","${client.extraNonceAndSessionId}"]],"${client.extraNonceAndSessionId}",8]}\n`, expect.any(Function));

    });

    it('should disable application idle timeout after Stratum initialization', async () => {
        const setTimeoutSpy = jest.spyOn(socket, 'setTimeout').mockImplementation(() => socket);
        jest.spyOn(client as any, 'write').mockImplementation(() => Promise.resolve(true));

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        expect(setTimeoutSpy).toHaveBeenCalledWith(0);
    });

    it('disconnects a buffered client before building another mining job', async () => {
        jest.spyOn(client as any, 'write').mockResolvedValue(true);
        jest.spyOn(socket, 'write').mockImplementation(() => true);
        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise(resolve => setTimeout(resolve, 100));

        (client as any).maxSocketBufferBytes = 256;
        const boundedSocket = {
            destroyed: false,
            writableEnded: false,
            writableLength: 256,
            write: jest.fn(),
            destroy: jest.fn(),
            removeListener: jest.fn(),
        };
        (client as any).socket = boundedSocket;
        const buildJob = jest.spyOn(stratumV1JobsService, 'getOrCreateJob');

        const result = client.broadcastMiningJob(
            stratumV1JobsService.getLatestJobTemplate('solo'),
            true,
        );

        expect(result).toEqual({ status: 'closed', bytes: 0, bufferedBytes: 256 });
        expect(buildJob).not.toHaveBeenCalled();
        expect(boundedSocket.write).not.toHaveBeenCalled();
        expect(boundedSocket.destroy).toHaveBeenCalled();
    });

    it('disconnects without writing when a mining job would reach the socket buffer limit', async () => {
        jest.spyOn(client as any, 'write').mockResolvedValue(true);
        jest.spyOn(socket, 'write').mockImplementation(() => true);
        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise(resolve => setTimeout(resolve, 100));

        (client as any).maxSocketBufferBytes = 1;
        const boundedSocket = {
            destroyed: false,
            writableEnded: false,
            writableLength: 0,
            write: jest.fn(),
            destroy: jest.fn(),
            removeListener: jest.fn(),
        };
        (client as any).socket = boundedSocket;
        const buildJob = jest.spyOn(stratumV1JobsService, 'getOrCreateJob');

        const result = client.broadcastMiningJob(
            stratumV1JobsService.getLatestJobTemplate('solo'),
            true,
        );

        expect(result).toEqual({ status: 'closed', bytes: 0, bufferedBytes: 0 });
        expect(buildJob).toHaveBeenCalledTimes(1);
        expect(boundedSocket.write).not.toHaveBeenCalled();
        expect(boundedSocket.destroy).toHaveBeenCalled();
    });

    it('reports bytes already queued when a write crosses the socket buffer limit', async () => {
        jest.spyOn(client as any, 'write').mockResolvedValue(true);
        jest.spyOn(socket, 'write').mockImplementation(() => true);
        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise(resolve => setTimeout(resolve, 100));

        (client as any).maxSocketBufferBytes = 4096;
        let writableLengthReads = 0;
        const boundedSocket = {
            destroyed: false,
            writableEnded: false,
            get writableLength() {
                return writableLengthReads++ < 2 ? 0 : 4096;
            },
            write: jest.fn(() => true),
            destroy: jest.fn(),
            removeListener: jest.fn(),
        };
        (client as any).socket = boundedSocket;

        const result = client.broadcastMiningJob(
            stratumV1JobsService.getLatestJobTemplate('solo'),
            true,
        );

        expect(result.status).toBe('closed');
        expect(result.bytes).toBeGreaterThan(0);
        expect(result.bufferedBytes).toBe(4096);
        expect(boundedSocket.write).toHaveBeenCalledTimes(1);
        expect(boundedSocket.destroy).toHaveBeenCalled();
    });

    it('should block non-compliant user agents on subscribe without allocating a session', async () => {
        (configService.get as jest.Mock).mockImplementation((key: string) => {
            switch (key) {
                case 'NON_COMPLIANT_USER_AGENTS':
                    return 'NMMiner';
                case 'DEV_FEE_ADDRESS':
                    return 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4';
                case 'NETWORK':
                    return 'testnet';
            }
            return null;
        });
        jest.spyOn(socket, 'write').mockImplementation((data) => true);

        emitMessage(`{"id":1,"method":"mining.subscribe","params":["NMMiner/1.0"]}`);
        await new Promise((r) => setTimeout(r, 1));

        expect(socket.destroy).toHaveBeenCalled();
        expect(socket.write).not.toHaveBeenCalled();
        expect((client as any).statistics).toBeUndefined();
        expect(consoleLogSpy).toHaveBeenCalledWith('Blocked non-compliant connection from userAgent: NMMiner');
    });

    it('should throttle repeated non-compliant user agent logs', async () => {
        (configService.get as jest.Mock).mockImplementation((key: string) => {
            switch (key) {
                case 'NON_COMPLIANT_USER_AGENTS':
                    return 'NMMiner';
                case 'DEV_FEE_ADDRESS':
                    return 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4';
                case 'NETWORK':
                    return 'testnet';
            }
            return null;
        });
        jest.spyOn(socket, 'write').mockImplementation((data) => true);

        emitMessage(`{"id":1,"method":"mining.subscribe","params":["NMMiner/1.0"]}`);
        await new Promise((r) => setTimeout(r, 1));

        const secondSocket = new Socket();
        jest.spyOn(secondSocket, 'on').mockImplementation((event: string, listener: (...args: any[]) => void) => {
            socketEmitter = listener;
            return secondSocket;
        });
        secondSocket.end = jest.fn();
        jest.spyOn(secondSocket, 'destroy').mockImplementation(() => secondSocket);
        const secondClient = new StratumV1Client(
            secondSocket,
            stratumV1JobsService,
            bitcoinRpcService,
            clientService,
            notificationService,
            blocksService,
            configService,
            addressSettings
        );

        socketEmitter(Buffer.from(`{"id":1,"method":"mining.subscribe","params":["NMMiner/1.0"]}\n`));
        await new Promise((r) => setTimeout(r, 1));

        expect(secondSocket.destroy).toHaveBeenCalled();
        expect(consoleLogSpy.mock.calls.filter(call => call[0]?.startsWith('Blocked non-compliant connection'))).toHaveLength(1);
        await secondClient.destroy();
    });


    it('should respond to mining.configure', async () => {

        jest.spyOn(socket, 'write').mockImplementation((data) => true);

        expect(socket.on).toHaveBeenCalled();
        emitMessage(MockRecording1.MINING_CONFIGURE);
        await new Promise((r) => setTimeout(r, 1));
        expect(socket.write).toHaveBeenCalledWith(`{"id":2,"error":null,"result":{"version-rolling":true,"version-rolling.mask":"1fffe000"}}\n`, expect.any(Function));
    });

    it('should respond to mining.authorize', async () => {

        jest.spyOn(socket, 'write').mockImplementation((data) => true);

        expect(socket.on).toHaveBeenCalled();
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 1));
        expect(socket.write).toHaveBeenCalledWith('{"id":3,"error":null,"result":true}\n', expect.any(Function));
    });

    it('should respond to mining.suggest_difficulty', async () => {
        jest.spyOn(socket, 'write').mockImplementation((data) => true);

        expect(socket.on).toHaveBeenCalled();
        emitMessage(MockRecording1.MINING_SUGGEST_DIFFICULTY);
        await new Promise((r) => setTimeout(r, 1));
        expect(socket.write).toHaveBeenCalledWith(`{"id":null,"method":"mining.set_difficulty","params":[512]}\n`, expect.any(Function));
    });

    it('should clamp suggested difficulty to the configured minimum', async () => {
        (configService.get as jest.Mock).mockImplementation((key: string) => {
            switch (key) {
                case 'STRATUM_MIN_DIFFICULTY':
                    return '1';
                case 'DEV_FEE_ADDRESS':
                    return 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4';
                case 'NETWORK':
                    return 'testnet';
            }
            return null;
        });
        jest.spyOn(socket, 'write').mockImplementation((data) => true);

        emitMessage(`{"id":4,"method":"mining.suggest_difficulty","params":[0]}`);
        await new Promise((r) => setTimeout(r, 1));

        expect(socket.write).toHaveBeenCalledWith(`{"id":null,"method":"mining.set_difficulty","params":[1]}\n`, expect.any(Function));
    });

    it('should set difficulty', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        expect((client as any).write).toHaveBeenCalledWith(`{"id":null,"method":"mining.set_difficulty","params":[100000]}\n`);

    });

    it('should pair a solo difficulty change with clean solo work when merged latest is PPLNS', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));
        jest.spyOn(socket, 'write').mockImplementation(() => true);

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        newBlockEmitter.next({
            ...MockRecording1.BLOCK_TEMPLATE,
            transactions: MockRecording1.BLOCK_TEMPLATE.transactions.slice(0, -1),
            payoutMode: 'solo',
        });
        newBlockEmitter.next({
            ...MockRecording1.BLOCK_TEMPLATE,
            transactions: MockRecording1.BLOCK_TEMPLATE.transactions.slice(0, -2),
            payoutMode: 'pplns',
            payoutSnapshotId: 'opposite-mode-snapshot',
            payoutOutputs: [{
                address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
                amountSats: MockRecording1.BLOCK_TEMPLATE.coinbasevalue,
            }],
        });
        expect((await firstValueFrom(stratumV1JobsService.sv1MiningJob$)).blockData.payoutMode)
            .toBe('pplns');

        jest.spyOn((client as any).statistics, 'getSuggestedDifficulty').mockReturnValue(200000);
        const broadcastSpy = jest.spyOn(client, 'broadcastMiningJob');
        await (client as any).checkDifficulty();

        const [refreshedTemplate, force] = broadcastSpy.mock.calls.at(-1);
        expect(refreshedTemplate.blockData).toEqual(expect.objectContaining({
            payoutMode: 'solo',
            clearJobs: true,
        }));
        expect(force).toBe(true);
    });

    it('should save client', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));
        emitMessage(MockRecording1.MINING_SUBMIT);
        await new Promise((r) => setTimeout(r, 100));

        const clientCount = await clientService.connectedClientCount();
        expect(clientCount).toBe(1);

    });




    it('should send job and accept submission', async () => {



        const date = new Date(parseInt(MockRecording1.TIME, 16) * 1000);


        jest.setSystemTime(date);

        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));
        const socketWriteSpy = jest.spyOn(socket, 'write').mockImplementation(() => true);


        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);



        await new Promise((r) => setTimeout(r, 100));




        expect(socketWriteSpy).toHaveBeenCalledWith(Buffer.from(`{"id":null,"method":"mining.notify","params":["1","171592f223740e92d223f6e68bff25279af7ac4f2246451e0000000200000000","02000000010000000000000000000000000000000000000000000000000000000000000000ffffffff1b03c943255075626c69632d506f6f6c","ffffffff02b59f250000000000160014e6f22ca44dc800e9d049621a3b9a42c509f1c4bc0000000000000000266a24aa21a9edbd3d1d916aa0b57326a2d88ebe1b68a1d7c48585f26d8335fe6a94b62755f64c00000000",["175335649d5e8746982969ec88f52e85ac9917106fba5468e699c8879ab974a1","d5644ab3e708c54cd68dc5aedc92b8d3037449687f92ec41ed6e37673d969d4a","5c9ec187517edc0698556cca5ce27e54c96acb014770599ed9df4d4937fbf2b0"],"20000000","192495f8","${MockRecording1.TIME}",true]}\n`));


        emitMessage(MockRecording1.MINING_SUBMIT);

        jest.useRealTimers();
        await new Promise((r) => setTimeout(r, 1000));

        expect((client as any).write).lastCalledWith(`{\"id\":5,\"error\":null,\"result\":true}\n`);
        expect(shareAccountingService.recordAcceptedShare).toHaveBeenCalledWith(expect.objectContaining({
            protocol: 'sv1',
            address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
            clientName: 'bitaxe3',
            sessionId: MockRecording1.EXTRA_NONCE,
            jobId: '1',
            jobTemplateId: '1',
            creditedDifficulty: 0,
            isBlockCandidate: false,
        }));
    });

    it('should use the header-only fast path for non-block submissions', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));
        const buildHeaderSpy = jest.spyOn(MiningJob.prototype, 'buildHeaderBuffer');
        const fullBlockSpy = jest.spyOn(MiningJob.prototype, 'copyAndUpdateBlock');

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        emitMessage(MockRecording1.MINING_SUBMIT);
        jest.useRealTimers();
        await new Promise((r) => setTimeout(r, 1000));

        expect(buildHeaderSpy).toHaveBeenCalled();
        expect(fullBlockSpy).not.toHaveBeenCalled();
    });

    it('should write accepted response before share accounting finishes', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        let finishAccounting: () => void;
        const accountingPromise = new Promise<void>((resolve) => {
            finishAccounting = resolve;
        });
        jest.spyOn((client as any).statistics, 'addShares').mockReturnValue(accountingPromise);

        emitMessage(MockRecording1.MINING_SUBMIT);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect((client as any).write).toHaveBeenCalledWith(`{"id":5,"error":null,"result":true}\n`);

        finishAccounting();
        jest.useRealTimers();
        await new Promise((r) => setTimeout(r, 100));
    });

    it('should update address best difficulty through the atomic path', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));
        jest.spyOn(client as any, 'calculateDifficulty').mockReturnValue({
            submissionDifficulty: 1024,
            submissionHash: 'share',
            hashBuffer: DifficultyUtils.difficultyToTarget(1024),
        });
        const getSettingsSpy = jest.spyOn(addressSettings, 'getSettings');
        const updateIfHigherSpy = jest.spyOn(addressSettings as any, 'updateBestDifficultyIfHigher').mockResolvedValue({ affected: 1 });
        const clientUpdateIfHigherSpy = jest.spyOn(clientService as any, 'updateBestDifficultyIfHigher').mockResolvedValue({ affected: 1 });

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        emitMessage(MockRecording1.MINING_SUBMIT);
        jest.useRealTimers();
        await new Promise((r) => setTimeout(r, 1000));

        expect(updateIfHigherSpy).toHaveBeenCalledWith(
            'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
            1024,
            expect.any(String)
        );
        expect(clientUpdateIfHigherSpy).toHaveBeenCalledWith(expect.any(String), 1024);
        expect(getSettingsSpy).not.toHaveBeenCalled();
    });

    it('should reject shares by exact target even when reported difficulty is huge', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));
        jest.spyOn(client as any, 'calculateDifficulty').mockReturnValue({
            submissionDifficulty: Number.MAX_SAFE_INTEGER,
            submissionHash: 'too-easy',
            hashBuffer: Buffer.alloc(32, 0xff),
        });

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [1024]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        emitMessage(MockRecording1.MINING_SUBMIT);
        jest.useRealTimers();
        await new Promise((r) => setTimeout(r, 1000));

        expect((client as any).write).lastCalledWith(`{"id":5,"result":null,"error":[23,"Difficulty too low",""]}\n`);
        expect(shareAccountingService.recordAcceptedShare).not.toHaveBeenCalled();
    });

    it('should submit a network-target candidate even when it misses the harder session target', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        const jobTemplate = stratumV1JobsService.getLatestJobTemplate('solo');
        const networkTarget = DifficultyUtils.compactToTarget(jobTemplate.block.bits);
        expect(networkTarget).not.toBeNull();
        (client as any).sessionDifficultyTarget = Buffer.alloc(32);
        const addSharesSpy = jest.spyOn((client as any).statistics, 'addShares');
        jest.spyOn(client as any, 'calculateDifficulty').mockReturnValue({
            submissionDifficulty: 1234,
            submissionHash: 'network-block-below-session-target',
            hashBuffer: networkTarget,
        });

        emitMessage(MockRecording1.MINING_SUBMIT);
        jest.useRealTimers();
        await new Promise((r) => setTimeout(r, 1000));

        expect(bitcoinRpcService.SUBMIT_BLOCK).toHaveBeenCalledWith(expect.any(String));
        expect((client as any).write).toHaveBeenCalledWith(`{"id":5,"error":null,"result":true}\n`);
        expect(shareAccountingService.recordAcceptedShare).toHaveBeenCalledWith(expect.objectContaining({
            isBlockCandidate: true,
            creditedDifficulty: 1234,
            submissionDifficulty: 1234,
        }));
        expect(addSharesSpy).toHaveBeenCalledWith(expect.any(Object), 1234);
    });

    it('should reject duplicate submissions', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        emitMessage(MockRecording1.MINING_SUBMIT);
        await new Promise((r) => setTimeout(r, 100));
        emitMessage(MockRecording1.MINING_SUBMIT);
        await new Promise((r) => setTimeout(r, 100));

        expect((client as any).write).lastCalledWith(`{"id":5,"result":null,"error":[22,"Duplicate share",""]}\n`);
    });

    it('should accept a five-field submission without clearing advertised version bits', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));
        const baseVersion = (MockRecording1.BLOCK_TEMPLATE.version | 0x00002000) | 0;
        newBlockEmitter.next({
            ...MockRecording1.BLOCK_TEMPLATE,
            version: baseVersion,
            transactions: MockRecording1.BLOCK_TEMPLATE.transactions.map(transaction => ({ ...transaction })),
        });

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        const submission = JSON.parse(MockRecording1.MINING_SUBMIT);
        submission.params.pop();
        emitMessage(JSON.stringify(submission));
        await new Promise((r) => setTimeout(r, 100));

        expect((client as any).write).lastCalledWith(`{"id":5,"error":null,"result":true}\n`);
        expect(shareAccountingService.recordAcceptedShare).toHaveBeenCalledWith(expect.objectContaining({
            version: (baseVersion >>> 0).toString(16),
        }));
    });

    it('should reject case-variant encodings of the same submission as duplicates', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        emitMessage(MockRecording1.MINING_SUBMIT);
        await new Promise((r) => setTimeout(r, 100));
        const variant = JSON.parse(MockRecording1.MINING_SUBMIT);
        for (const index of [2, 3, 4, 5]) {
            variant.params[index] = variant.params[index].toUpperCase();
        }
        emitMessage(JSON.stringify(variant));
        await new Promise((r) => setTimeout(r, 100));

        expect((client as any).write).lastCalledWith(`{"id":5,"result":null,"error":[22,"Duplicate share",""]}\n`);
        expect(shareAccountingService.recordAcceptedShare).toHaveBeenCalledTimes(1);
    });

    it.each([
        { payoutMode: 'pplns' as const, payoutIdentity: 'pplns\0foreign-snapshot' },
        { payoutMode: 'solo' as const, payoutIdentity: 'solo\0foreign-address' },
    ])('should reject a $payoutMode job not owned by the connection', async ({ payoutMode, payoutIdentity }) => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));
        const calculateDifficultySpy = jest.spyOn(client as any, 'calculateDifficulty');

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        const template = stratumV1JobsService.getLatestJobTemplate('solo');
        const foreignJob = stratumV1JobsService.getOrCreateJob(
            bitcoinjs.networks.testnet,
            [{ address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', percent: 100 }],
            template,
            payoutIdentity,
            payoutMode,
        );
        const foreignSubmission = JSON.parse(MockRecording1.MINING_SUBMIT);
        foreignSubmission.params[1] = foreignJob.jobId;
        emitMessage(JSON.stringify(foreignSubmission));
        await new Promise((r) => setTimeout(r, 100));

        expect((client as any).write).lastCalledWith(`{"id":5,"result":null,"error":[21,"Job not found",""]}\n`);
        expect(calculateDifficultySpy).not.toHaveBeenCalled();
        expect(shareAccountingService.recordAcceptedShare).not.toHaveBeenCalled();
        expect(bitcoinRpcService.SUBMIT_BLOCK).not.toHaveBeenCalled();
    });

    it('should accept a legacy PPLNS template with explicit outputs and no snapshot id', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));
        (client as any).payoutMode = 'pplns';
        newBlockEmitter.next({
            ...MockRecording1.BLOCK_TEMPLATE,
            transactions: MockRecording1.BLOCK_TEMPLATE.transactions.map(transaction => ({ ...transaction })),
            payoutMode: 'all',
            payoutSnapshotId: undefined,
            payoutOutputs: [{
                address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
                amountSats: MockRecording1.BLOCK_TEMPLATE.coinbasevalue,
            }],
        });

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        const ownedJob = stratumV1JobsService.getJobById('1');
        expect(ownedJob.ownership).toEqual(expect.objectContaining({
            payoutMode: 'pplns',
            payoutIdentity: expect.stringMatching(/^pplns\0outputs\0/),
        }));

        emitMessage(MockRecording1.MINING_SUBMIT);
        await new Promise((r) => setTimeout(r, 100));

        expect((client as any).write).lastCalledWith(`{"id":5,"error":null,"result":true}\n`);
        expect(shareAccountingService.recordAcceptedShare).toHaveBeenCalledWith(expect.objectContaining({
            payoutMode: 'pplns',
            jobId: '1',
        }));
    });

    it('should retain duplicate detection across a clean tip switch', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));
        jest.spyOn(socket, 'write').mockImplementation(() => true);

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        expect((client as any).isDuplicateSubmission('old-tip-share')).toBe(false);
        expect((client as any).rememberSubmission('old-tip-share', '1')).toBe(true);
        const nextTip = {
            ...MockRecording1.BLOCK_TEMPLATE,
            previousblockhash: '11'.repeat(32),
            height: MockRecording1.BLOCK_TEMPLATE.height + 1,
            transactions: MockRecording1.BLOCK_TEMPLATE.transactions.map(tx => ({ ...tx })),
        };
        newBlockEmitter.next(nextTip);
        client.broadcastMiningJob(stratumV1JobsService.getLatestJobTemplate('solo'));

        expect((client as any).isDuplicateSubmission('old-tip-share')).toBe(true);
    });

    it('should preserve live accepted-share dedup entries when capacity is reached', () => {
        const getSubmissionContext = jest.spyOn(stratumV1JobsService, 'getSubmissionContext')
            .mockReturnValue({} as any);
        (configService.get as jest.Mock).mockImplementation((key: string) => {
            if (key === 'STRATUM_SUBMISSION_DEDUP_TTL_MS') return '1000';
            if (key === 'STRATUM_SUBMISSION_DEDUP_MAX_ENTRIES') return '2';
            if (key === 'NETWORK') return 'testnet';
            return null;
        });

        expect((client as any).isDuplicateSubmission('one')).toBe(false);
        expect((client as any).rememberSubmission('one', '1')).toBe(true);
        expect((client as any).isDuplicateSubmission('two')).toBe(false);
        expect((client as any).rememberSubmission('two', '1')).toBe(true);
        expect((client as any).rememberSubmission('three', '1')).toBe(false);
        expect([...(client as any).miningSubmissionHashes.keys()]).toEqual(['one', 'two']);

        jest.advanceTimersByTime(1001);
        expect((client as any).isDuplicateSubmission('two')).toBe(true);
        getSubmissionContext.mockReturnValue(null);
        expect((client as any).isDuplicateSubmission('two')).toBe(false);
        expect((client as any).rememberSubmission('three', '1')).toBe(true);
        expect([...(client as any).miningSubmissionHashes.keys()]).toEqual(['three']);
    });

    it('should hash and reject stale non-block shares without accounting them', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));
        jest.spyOn(socket, 'write').mockImplementation(() => true);
        const calculateDifficultySpy = jest.spyOn(client as any, 'calculateDifficulty').mockReturnValue({
            submissionDifficulty: 1,
            submissionHash: 'stale-share',
            hashBuffer: Buffer.alloc(32, 0xff),
        });
        const buildHeaderSpy = jest.spyOn(MiningJob.prototype, 'buildHeaderBuffer');

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        newBlockEmitter.next({
            ...MockRecording1.BLOCK_TEMPLATE,
            previousblockhash: '22'.repeat(32),
            height: MockRecording1.BLOCK_TEMPLATE.height + 1,
            transactions: MockRecording1.BLOCK_TEMPLATE.transactions.map(tx => ({ ...tx })),
        });
        emitMessage(MockRecording1.MINING_SUBMIT);
        await new Promise((r) => setTimeout(r, 100));

        expect(buildHeaderSpy).toHaveBeenCalled();
        expect(calculateDifficultySpy).toHaveBeenCalled();
        expect(bitcoinRpcService.SUBMIT_BLOCK).not.toHaveBeenCalled();
        expect(shareAccountingService.recordAcceptedShare).not.toHaveBeenCalled();
        expect((client as any).write).lastCalledWith(`{"id":5,"result":null,"error":[21,"Stale share",""]}\n`);
    });

    it('should reconstruct and submit an exact-target candidate from a stale tip', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));
        jest.spyOn(socket, 'write').mockImplementation(() => true);
        jest.spyOn(client as any, 'calculateDifficulty').mockReturnValue({
            submissionDifficulty: Number.POSITIVE_INFINITY,
            submissionHash: 'stale-block',
            hashBuffer: Buffer.alloc(32),
        });

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        newBlockEmitter.next({
            ...MockRecording1.BLOCK_TEMPLATE,
            previousblockhash: '33'.repeat(32),
            height: MockRecording1.BLOCK_TEMPLATE.height + 1,
            transactions: MockRecording1.BLOCK_TEMPLATE.transactions.map(tx => ({ ...tx })),
        });
        emitMessage(MockRecording1.MINING_SUBMIT);
        await new Promise((r) => setTimeout(r, 100));

        expect(bitcoinRpcService.SUBMIT_BLOCK).toHaveBeenCalledWith(expect.any(String));
        expect(blocksService.save).toHaveBeenCalledWith(expect.objectContaining({
            height: MockRecording1.BLOCK_TEMPLATE.height,
            blockSubmissionResult: null,
        }));
        expect(shareAccountingService.recordAcceptedShare).toHaveBeenCalledWith(expect.objectContaining({
            jobId: '1',
            isBlockCandidate: true,
            blockSubmissionResult: null,
        }));
        expect((client as any).write).lastCalledWith(`{"id":5,"error":null,"result":true}\n`);
    });

    it('should not credit a stale exact-target candidate rejected by Core', async () => {
        (bitcoinRpcService.SUBMIT_BLOCK as jest.Mock).mockResolvedValue('stale-prevblk');
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));
        jest.spyOn(socket, 'write').mockImplementation(() => true);
        jest.spyOn(client as any, 'calculateDifficulty').mockReturnValue({
            submissionDifficulty: Number.POSITIVE_INFINITY,
            submissionHash: 'rejected-stale-block',
            hashBuffer: Buffer.alloc(32),
        });

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        newBlockEmitter.next({
            ...MockRecording1.BLOCK_TEMPLATE,
            previousblockhash: '44'.repeat(32),
            height: MockRecording1.BLOCK_TEMPLATE.height + 1,
            transactions: MockRecording1.BLOCK_TEMPLATE.transactions.map(tx => ({ ...tx })),
        });
        emitMessage(MockRecording1.MINING_SUBMIT);
        await new Promise((r) => setTimeout(r, 100));

        expect(bitcoinRpcService.SUBMIT_BLOCK).toHaveBeenCalledWith(expect.any(String));
        expect(blocksService.save).toHaveBeenCalledWith(expect.objectContaining({
            blockSubmissionResult: 'stale-prevblk',
        }));
        expect(shareAccountingService.recordAcceptedShare).not.toHaveBeenCalled();
        expect((client as any).write).lastCalledWith(`{"id":5,"result":null,"error":[21,"Stale share",""]}\n`);
    });

    it('should reject submissions for unknown jobs', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));
        const hashSpy = jest.spyOn(MiningSubmitMessage.prototype, 'hash');

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        emitMessage(`{"id": 5, "method": "mining.submit", "params": ["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3", "ff", "c708000000000000", "64b3f3ec", "ed460d91", "00002000"]}`);
        await new Promise((r) => setTimeout(r, 100));

        expect((client as any).write).lastCalledWith(`{"id":5,"result":null,"error":[21,"Job not found",""]}\n`);
        expect(await clientService.connectedClientCount()).toBe(1);
        expect(hashSpy).not.toHaveBeenCalled();
        expect(shareAccountingService.recordAcceptedShare).not.toHaveBeenCalled();
    });

    it('should reject submissions when the job template has expired', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));
        stratumV1JobsService.blocks = {};

        emitMessage(MockRecording1.MINING_SUBMIT);
        await new Promise((r) => setTimeout(r, 100));

        expect((client as any).write).lastCalledWith(`{"id":5,"result":null,"error":[21,"Job not found",""]}\n`);
    });

    it('should reject low difficulty shares', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(MockRecording1.MINING_SUGGEST_DIFFICULTY);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        emitMessage(MockRecording1.MINING_SUBMIT);
        await new Promise((r) => setTimeout(r, 100));

        expect((client as any).write).lastCalledWith(`{"id":5,"result":null,"error":[23,"Difficulty too low",""]}\n`);
        expect(await clientService.connectedClientCount()).toBe(1);
        expect(shareAccountingService.recordAcceptedShare).not.toHaveBeenCalled();
        expect((client as any).miningSubmissionHashes.size).toBe(0);
    });

    it.each([
        { label: 'before the advertised job time', offsetSeconds: -1 },
        { label: 'more than two hours in the future', offsetSeconds: (2 * 60 * 60) + 1 },
    ])('rejects ntime $label before hashing or accounting', async ({ offsetSeconds }) => {
        jest.spyOn(client as any, 'write').mockResolvedValue(true);
        const calculateDifficultySpy = jest.spyOn(client as any, 'calculateDifficulty');

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((resolve) => setTimeout(resolve, 100));

        const submission = JSON.parse(MockRecording1.MINING_SUBMIT);
        const baseTime = parseInt(MockRecording1.TIME, 16);
        submission.params[3] = (baseTime + offsetSeconds).toString(16).padStart(8, '0');
        emitMessage(JSON.stringify(submission));
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect((client as any).write).lastCalledWith(
            `{"id":5,"result":null,"error":[20,"Invalid ntime",""]}\n`,
        );
        expect(calculateDifficultySpy).not.toHaveBeenCalled();
        expect(shareAccountingService.recordAcceptedShare).not.toHaveBeenCalled();
    });

    it('rejects version rolling masks outside the negotiated BIP320 range', async () => {
        jest.spyOn(client as any, 'write').mockImplementation(() => Promise.resolve(true));

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((resolve) => setTimeout(resolve, 100));

        const invalid = JSON.parse(MockRecording1.MINING_SUBMIT);
        invalid.params[5] = '20000000';
        emitMessage(JSON.stringify(invalid));
        jest.useRealTimers();
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect((client as any).write).lastCalledWith(
            `{"id":5,"result":null,"error":[20,"Invalid version mask",""]}\n`,
        );
        expect(shareAccountingService.recordAcceptedShare).not.toHaveBeenCalled();
    });

    it('reconstructs BIP310 replacement bits when the job version already has the bit set', async () => {
        const versionBit = 0x00002000;
        const baseVersion = (MockRecording1.BLOCK_TEMPLATE.version | versionBit) | 0;
        newBlockEmitter.next({
            ...MockRecording1.BLOCK_TEMPLATE,
            version: baseVersion,
            transactions: MockRecording1.BLOCK_TEMPLATE.transactions.map(transaction => ({ ...transaction })),
        });
        jest.spyOn(client as any, 'write').mockResolvedValue(true);
        jest.spyOn(client as any, 'calculateDifficulty').mockReturnValue({
            submissionDifficulty: Number.POSITIVE_INFINITY,
            submissionHash: 'bip310-candidate',
            hashBuffer: Buffer.alloc(32),
        });
        const buildHeader = jest.spyOn(MiningJob.prototype, 'buildHeaderBuffer');

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise(resolve => setTimeout(resolve, 100));
        const submission = JSON.parse(MockRecording1.MINING_SUBMIT);
        submission.params[5] = versionBit.toString(16).padStart(8, '0');
        emitMessage(JSON.stringify(submission));
        await new Promise(resolve => setTimeout(resolve, 100));

        const expectedVersion = baseVersion >>> 0;
        const header = buildHeader.mock.results.at(-1).value as Buffer;
        const submittedBlockHex = (bitcoinRpcService.SUBMIT_BLOCK as jest.Mock).mock.calls.at(-1)[0] as string;
        expect(header.readUInt32LE(0)).toBe(expectedVersion);
        expect(Buffer.from(submittedBlockHex.slice(0, 160), 'hex').readUInt32LE(0)).toBe(expectedVersion);
        expect(submittedBlockHex.slice(0, 160)).toBe(header.toString('hex'));
        expect(shareAccountingService.recordAcceptedShare).toHaveBeenCalledWith(expect.objectContaining({
            version: expectedVersion.toString(16),
            isBlockCandidate: true,
        }));
    });

    it('should reject submissions with short extranonce2 values', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        emitMessage(`{"id": 5, "method": "mining.submit", "params": ["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3", "1", "c7080000", "64b3f3ec", "ed460d91", "00002000"]}`);
        await new Promise((r) => setTimeout(r, 100));

        expect((client as any).write).lastCalledWith(expect.stringContaining(`"error":[20,"Mining Submit validation error"`));
        expect(socket.destroy).toHaveBeenCalled();
        expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Mining Submit validation error: extraNonce2:isLength'));
    });

    it('should throttle repeated mining submit validation logs', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        emitMessage(`{"id": 5, "method": "mining.submit", "params": ["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3", "1", "c7080000", "64b3f3ec", "ed460d91", "00002000"]}`);
        await new Promise((r) => setTimeout(r, 100));

        const secondSocket = new Socket();
        jest.spyOn(secondSocket, 'on').mockImplementation((event: string, listener: (...args: any[]) => void) => {
            socketEmitter = listener;
            return secondSocket;
        });
        secondSocket.end = jest.fn();
        jest.spyOn(secondSocket, 'destroy').mockImplementation(() => secondSocket);
        const secondClient = new StratumV1Client(
            secondSocket,
            stratumV1JobsService,
            bitcoinRpcService,
            clientService,
            notificationService,
            blocksService,
            configService,
            addressSettings
        );
        jest.spyOn(secondClient as any, 'write').mockImplementation((data) => Promise.resolve(true));
        jest.spyOn(secondClient as any, 'getRandomHexString').mockReturnValue(MockRecording1.EXTRA_NONCE);

        socketEmitter(Buffer.from(`${MockRecording1.MINING_SUBSCRIBE}\n`));
        socketEmitter(Buffer.from(`${MockRecording1.MINING_AUTHORIZE}\n`));
        await new Promise((r) => setTimeout(r, 100));
        socketEmitter(Buffer.from(`{"id": 5, "method": "mining.submit", "params": ["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3", "1", "c7080000", "64b3f3ec", "ed460d91", "00002000"]}\n`));
        await new Promise((r) => setTimeout(r, 100));

        expect(consoleWarnSpy.mock.calls.filter(call => call[0]?.startsWith('Mining Submit validation error'))).toHaveLength(1);
        await secondClient.destroy();
    });

    it('should close socket when a submit arrives before stratum is initialized', async () => {
        const endSpy = jest.spyOn(socket, 'end');

        emitMessage(MockRecording1.MINING_SUBMIT);
        await new Promise((r) => setTimeout(r, 100));

        expect(endSpy).toHaveBeenCalled();
    });

    it('should submit and persist found blocks', async () => {
        (bitcoinRpcService.SUBMIT_BLOCK as jest.Mock).mockResolvedValue('SUCCESS!');
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));
        jest.spyOn(client as any, 'calculateDifficulty').mockReturnValue({
            submissionDifficulty: Number.MAX_SAFE_INTEGER,
            submissionHash: 'block-share',
            hashBuffer: Buffer.alloc(32),
        });
        jest.spyOn(addressSettings, 'resetBestDifficultyAndShares').mockResolvedValue(undefined);

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        emitMessage(MockRecording1.MINING_SUBMIT);
        jest.useRealTimers();
        await new Promise((r) => setTimeout(r, 1000));

        expect(bitcoinRpcService.SUBMIT_BLOCK).toHaveBeenCalledWith(expect.any(String));
        expect(blocksService.save).toHaveBeenCalledWith(expect.objectContaining({
            height: MockRecording1.BLOCK_TEMPLATE.height,
            minerAddress: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
            worker: 'bitaxe3',
            sessionId: MockRecording1.EXTRA_NONCE,
            blockData: expect.any(String),
            payoutSnapshotId: null,
            payoutMode: 'solo',
        }));
        expect(notificationService.notifySubscribersBlockFound).toHaveBeenCalled();
        expect(addressSettings.resetBestDifficultyAndShares).toHaveBeenCalled();
        expect((client as any).write).lastCalledWith(`{"id":5,"error":null,"result":true}\n`);
    });



});
