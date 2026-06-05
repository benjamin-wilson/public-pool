import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Socket } from 'net';
import { BehaviorSubject } from 'rxjs';
import { DataSource } from 'typeorm';

import { MockRecording1 } from '../../test/models/MockRecording1';
import { AddressSettingsModule } from '../ORM/address-settings/address-settings.module';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksEntity } from '../ORM/blocks/blocks.entity';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientStatisticsEntity } from '../ORM/client-statistics/client-statistics.entity';
import { ClientStatisticsModule } from '../ORM/client-statistics/client-statistics.module';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ClientModule } from '../ORM/client/client.module';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService as MockBitcoinRpcService } from '../services/bitcoin-rpc.service';
import { NotificationService } from '../services/notification.service';
import { StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { IBlockTemplate } from './bitcoin-rpc/IBlockTemplate';
import { IMiningInfo } from './bitcoin-rpc/IMiningInfo';
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
    let clientStatisticsService: ClientStatisticsService;
    let notificationService: NotificationService;
    let blocksService: BlocksService;
    let externalSharesService;
    let configService: ConfigService;

    let client: StratumV1Client;

    let socketEmitter: (...args: any[]) => void;
    const emitMessage = (message: string) => socketEmitter(Buffer.from(`${message}\n`));
    let consoleLogSpy: jest.SpyInstance;
    let consoleErrorSpy: jest.SpyInstance;
    let consoleWarnSpy: jest.SpyInstance;

    let newBlockEmitter: BehaviorSubject<IMiningInfo> = new BehaviorSubject({
        blocks: MockRecording1.BLOCK_TEMPLATE.height
    } as IMiningInfo);

    let moduleRef: TestingModule;

    beforeAll(async () => {
        moduleRef = await Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'sqlite',
                    database: ':memory:',
                    synchronize: true,
                    autoLoadEntities: true,
                    cache: true,
                    logging: false,
                    entities: [ClientEntity, ClientStatisticsEntity, BlocksEntity]
                }),
                ClientModule,
                ClientStatisticsModule,
                AddressSettingsModule
            ],
            providers: [
                {
                    provide: ConfigService,
                    useValue: {
                        get: jest.fn((key: string) => {
                            switch (key) {
                                case 'DEV_FEE_ADDRESS':
                                    return 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4';
                                case 'NETWORK':
                                    return 'testnet';
                            }
                            return null;
                        })
                    }
                }
            ],
        }).compile();


    })


    beforeEach(async () => {

        jest.useFakeTimers({ advanceTimers: true })
        jest.setSystemTime(new Date(parseInt(MockRecording1.TIME, 16) * 1000));
        consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        clientService = moduleRef.get<ClientService>(ClientService);
        clientService.insertQueue = [];

        const dataSource = moduleRef.get<DataSource>(DataSource);

        await dataSource.getRepository(ClientStatisticsEntity).clear();
        await dataSource.getRepository(ClientEntity).clear();
        await dataSource.getRepository(BlocksEntity).clear();


        clientStatisticsService = moduleRef.get<ClientStatisticsService>(ClientStatisticsService);

        configService = moduleRef.get<ConfigService>(ConfigService);
        (configService.get as jest.Mock).mockImplementation((key: string) => {
            switch (key) {
                case 'DEV_FEE_ADDRESS':
                    return 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4';
                case 'NETWORK':
                    return 'testnet';
            }
            return null;
        });
        (StratumV1Client as any).blockedUserAgentLogState.clear();
        (StratumV1Client as any).validationErrorLogState.clear();

        bitcoinRpcService = new MockBitcoinRpcService(configService,null);
        jest.spyOn(bitcoinRpcService, 'getBlockTemplate').mockReturnValue(Promise.resolve(MockRecording1.BLOCK_TEMPLATE));
        bitcoinRpcService.newBlock$ = newBlockEmitter.asObservable();


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

        const addressSettings = moduleRef.get<AddressSettingsService>(AddressSettingsService);
        notificationService = {
            notifySubscribersBlockFound: jest.fn().mockResolvedValue(undefined)
        } as any;
        blocksService = {
            save: jest.fn().mockResolvedValue(undefined)
        } as any;
        externalSharesService = {
            submitShare: jest.fn().mockResolvedValue(undefined)
        };


        client = new StratumV1Client(
            socket,
            stratumV1JobsService,
            bitcoinRpcService,
            clientService,
            clientStatisticsService,
            notificationService,
            blocksService,
            configService,
            addressSettings,
            externalSharesService
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
            clientStatisticsService,
            notificationService,
            blocksService,
            configService,
            moduleRef.get<AddressSettingsService>(AddressSettingsService),
            externalSharesService
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

    it('should set difficulty', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        expect((client as any).write).toHaveBeenCalledWith(`{"id":null,"method":"mining.set_difficulty","params":[100000]}\n`);

    });

    it('should save client', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));
        emitMessage(MockRecording1.MINING_SUBMIT);
        await new Promise((r) => setTimeout(r, 100));
        await clientService.insertClients();
        await new Promise((r) => setTimeout(r, 100));

        const clientCount = await clientService.connectedClientCount();
        expect(clientCount).toBe(1);

    });




    it('should send job and accept submission', async () => {



        const date = new Date(parseInt(MockRecording1.TIME, 16) * 1000);


        jest.setSystemTime(date);

        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));


        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);



        await new Promise((r) => setTimeout(r, 100));

        const notifyCall = (client as any).write.mock.calls
            .map(call => call[0])
            .find((message: string) => message.includes('"method":"mining.notify"'));
        const notify = JSON.parse(notifyCall);

        expect(notify.params[0]).toBe('1');
        expect(notify.params[5]).toBe('20000000');
        expect(notify.params[6]).toBe('192495f8');
        expect(notify.params[7]).toBe(MockRecording1.TIME);
        expect(notify.params[8]).toBe(true);


        emitMessage(MockRecording1.MINING_SUBMIT);

        jest.useRealTimers();
        await new Promise((r) => setTimeout(r, 1000));

        expect((client as any).write).lastCalledWith(`{\"id\":5,\"error\":null,\"result\":true}\n`);


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
        await new Promise((r) => setTimeout(r, 100));
        await clientService.insertClients();
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
            submissionHash: 'share'
        });
        const addressSettings = moduleRef.get<AddressSettingsService>(AddressSettingsService);
        const getSettingsSpy = jest.spyOn(addressSettings, 'getSettings');
        const updateIfHigherSpy = jest.spyOn(addressSettings as any, 'updateBestDifficultyIfHigher').mockResolvedValue({ affected: 1 });
        const clientUpdateIfHigherSpy = jest.spyOn(clientService as any, 'updateBestDifficultyIfHigher').mockResolvedValue({ affected: 1 });

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        emitMessage(MockRecording1.MINING_SUBMIT);
        await new Promise((r) => setTimeout(r, 100));
        await clientService.insertClients();
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
        expect(await clientService.connectedClientCount()).toBe(0);
        expect(hashSpy).not.toHaveBeenCalled();
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

        expect((client as any).write).lastCalledWith(`{"id":5,"result":null,"error":[21,"Job Template not found",""]}\n`);
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
        expect(await clientService.connectedClientCount()).toBe(0);
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
            clientStatisticsService,
            notificationService,
            blocksService,
            configService,
            moduleRef.get<AddressSettingsService>(AddressSettingsService),
            externalSharesService
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
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));
        jest.spyOn(client as any, 'calculateDifficulty').mockReturnValue({
            submissionDifficulty: Number.MAX_SAFE_INTEGER,
            submissionHash: 'block-share'
        });
        const addressSettings = moduleRef.get<AddressSettingsService>(AddressSettingsService);
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
            blockData: expect.any(String)
        }));
        expect(notificationService.notifySubscribersBlockFound).toHaveBeenCalled();
        expect(addressSettings.resetBestDifficultyAndShares).toHaveBeenCalled();
        expect((client as any).write).lastCalledWith(`{"id":5,"error":null,"result":true}\n`);
    });



});
