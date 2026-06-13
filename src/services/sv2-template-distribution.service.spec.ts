import * as bitcoinjs from 'bitcoinjs-lib';
import { BehaviorSubject, firstValueFrom } from 'rxjs';

import { MockRecording1 } from '../../test/models/MockRecording1';
import { BufferReader } from '../models/sv2/sv2-binary-codec';
import { MiningJob } from '../models/MiningJob';
import { Sv2MsgType, Sv2Protocol } from '../models/sv2/sv2-constants';
import {
    deserializeSetupConnectionSuccess,
    serializeSetupConnection,
} from '../models/sv2/sv2-messages';
import { serializeTdpCoinbaseOutputConstraints } from '../models/sv2/sv2-tdp-messages';
import {
    deserializeTdpNewTemplate,
    deserializeTdpRequestTransactionDataSuccess,
    serializeTdpRequestTransactionData,
    serializeTdpSubmitSolution,
} from '../models/sv2/sv2-tdp-messages';
import { StratumV1JobsService } from './stratum-v1-jobs.service';
import { Sv2TemplateDistributionConnection } from './sv2-template-distribution.service';
import { TemplateProviderService } from './template-provider.service';

describe('Sv2TemplateDistributionConnection compliance', () => {
    it('waits for client CoinbaseOutputConstraints before sending templates', async () => {
        const { connection, sentFrames, templateProvider, jobTemplate } = await createConnection();

        await (connection as any).handleSetupConnection(serializeSetupConnection({
            protocol: Sv2Protocol.TEMPLATE_DISTRIBUTION,
            minVersion: 2,
            maxVersion: 2,
            flags: 0,
            endpoint_host: 'localhost',
            endpoint_port: 34265,
            vendor: 'template-client',
            hardwareVersion: '',
            firmwareVersion: '',
            deviceId: '',
        }));

        expect(sentFrames.map(frame => frame.msgType)).toEqual([Sv2MsgType.SETUP_CONNECTION_SUCCESS]);
        const success = deserializeSetupConnectionSuccess(new BufferReader(sentFrames[0].payload));
        expect(success.flags).toBe(0);

        sentFrames.length = 0;
        await (connection as any).handleFrame(
            Sv2MsgType.TDP_COINBASE_OUTPUT_CONSTRAINTS,
            serializeTdpCoinbaseOutputConstraints({
                coinbaseOutputMaxAdditionalSize: 50_000,
                coinbaseOutputMaxAdditionalSigops: 0,
            }),
        );
        await Promise.resolve();
        await Promise.resolve();

        expect(sentFrames.some(frame => frame.msgType === Sv2MsgType.TDP_NEW_TEMPLATE)).toBe(true);
        expect(sentFrames.some(frame => frame.msgType === Sv2MsgType.TDP_SET_NEW_PREV_HASH)).toBe(true);
        const templateFrame = sentFrames.find(frame => frame.msgType === Sv2MsgType.TDP_NEW_TEMPLATE);
        const template = deserializeTdpNewTemplate(new BufferReader(templateFrame.payload));
        const expectedJob = new MiningJob(
            bitcoinjs.networks.testnet,
            jobTemplate.blockData.id,
            [{ address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', percent: 100 }],
            jobTemplate,
        );
        const expectedCoinbaseTx = expectedJob.cloneCoinbaseTransaction();
        expect(template.coinbasePrefix).toEqual(expectedJob.getCoinbasePrefixBuffer());
        expect(template.coinbasePrefix.includes(templateProvider.buildCoinbaseHeightPrefix(MockRecording1.BLOCK_TEMPLATE.height))).toBe(true);
        expect(template.coinbaseTxVersion).toBe(expectedCoinbaseTx.version);
        expect(template.coinbaseTxInputSequence).toBe(expectedCoinbaseTx.ins[0].sequence);
        expect(template.coinbaseTxOutputsCount).toBe(expectedCoinbaseTx.outs.length);
        expect(template.coinbaseTxOutputs).toEqual((connection as any).serializeCoinbaseOutputs(expectedCoinbaseTx));
        expect(template.coinbaseTxLocktime).toBe(expectedCoinbaseTx.locktime);
    });

    it('serves transaction data for known templates', async () => {
        const { connection, sentFrames, templateProvider, jobTemplate } = await createConnection();
        const template = templateProvider.upsert(jobTemplate);

        await (connection as any).handleFrame(
            Sv2MsgType.TDP_REQUEST_TRANSACTION_DATA,
            serializeTdpRequestTransactionData({ templateId: template.templateId }),
        );

        const successFrame = sentFrames.find(frame => frame.msgType === Sv2MsgType.TDP_REQUEST_TRANSACTION_DATA_SUCCESS);
        const success = deserializeTdpRequestTransactionDataSuccess(new BufferReader(successFrame.payload));
        expect(success.templateId).toBe(template.templateId);
        expect(success.transactionList[0]).toEqual(Buffer.from(MockRecording1.BLOCK_TEMPLATE.transactions[0].data, 'hex'));
    });

    it('submits reconstructed blocks from SubmitSolution', async () => {
        const { connection, templateProvider, jobTemplate, bitcoinRpcService, blocksService, payoutSnapshotService, notificationService } = await createConnection();
        const template = templateProvider.upsert(jobTemplate);
        const callOrder: string[] = [];
        bitcoinRpcService.SUBMIT_BLOCK.mockImplementation(async () => {
            callOrder.push('submit');
            return null;
        });
        blocksService.save.mockImplementation(async () => {
            callOrder.push('save');
        });
        const coinbaseTx = createCoinbaseTransaction(templateProvider.buildCoinbaseHeightPrefix(template.height));

        await (connection as any).handleFrame(
            Sv2MsgType.TDP_SUBMIT_SOLUTION,
            serializeTdpSubmitSolution({
                templateId: template.templateId,
                version: template.version,
                headerTimestamp: template.minNtime,
                headerNonce: 123,
                coinbaseTx: coinbaseTx.toBuffer(),
            }),
        );

        expect(bitcoinRpcService.SUBMIT_BLOCK).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]+$/));
        expect(blocksService.save).toHaveBeenCalledWith(expect.objectContaining({
            height: MockRecording1.BLOCK_TEMPLATE.height,
            minerAddress: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
            worker: 'tdp',
            blockData: expect.stringMatching(/^[0-9a-f]+$/),
        }));
        expect(callOrder).toEqual(['submit', 'save']);
        expect(payoutSnapshotService.finalizeSnapshotForBlock).toHaveBeenCalledWith({
            payoutSnapshotId: jobTemplate.blockData.payoutSnapshotId,
            blockHeight: MockRecording1.BLOCK_TEMPLATE.height,
            blockSubmissionResult: null,
        });
        expect(notificationService.notifySubscribersBlockFound).toHaveBeenCalledWith(
            'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
            MockRecording1.BLOCK_TEMPLATE.height,
            expect.any(bitcoinjs.Block),
            null,
        );
    });

    it('does not resubmit duplicate SubmitSolution messages', async () => {
        const { connection, templateProvider, jobTemplate, bitcoinRpcService } = await createConnection();
        const template = templateProvider.upsert(jobTemplate);
        const coinbaseTx = createCoinbaseTransaction(templateProvider.buildCoinbaseHeightPrefix(template.height));
        const payload = serializeTdpSubmitSolution({
            templateId: template.templateId,
            version: template.version,
            headerTimestamp: template.minNtime,
            headerNonce: 123,
            coinbaseTx: coinbaseTx.toBuffer(),
        });

        await (connection as any).handleFrame(Sv2MsgType.TDP_SUBMIT_SOLUTION, payload);
        await (connection as any).handleFrame(Sv2MsgType.TDP_SUBMIT_SOLUTION, payload);

        expect(bitcoinRpcService.SUBMIT_BLOCK).toHaveBeenCalledTimes(1);
    });

    it('rejects SubmitSolution locally when the coinbase is missing the BIP34 height', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { connection, templateProvider, jobTemplate, bitcoinRpcService, blocksService } = await createConnection();
        const template = templateProvider.upsert(jobTemplate);
        const coinbaseTx = createCoinbaseTransaction(Buffer.from('/public-pool-sri-jdc-e2e/', 'utf8'));

        await (connection as any).handleFrame(
            Sv2MsgType.TDP_SUBMIT_SOLUTION,
            serializeTdpSubmitSolution({
                templateId: template.templateId,
                version: template.version,
                headerTimestamp: template.minNtime,
                headerNonce: 123,
                coinbaseTx: coinbaseTx.toBuffer(),
            }),
        );

        expect(bitcoinRpcService.SUBMIT_BLOCK).not.toHaveBeenCalled();
        expect(blocksService.save).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid-job-param-value-coinbase_tx_prefix'));
        warn.mockRestore();
    });

    it('submits using a served template snapshot after provider cache cleanup', async () => {
        const { connection, sentFrames, templateProvider, jobTemplate, bitcoinRpcService, blocksService } = await createConnection();
        await (connection as any).sendTemplate(jobTemplate);
        const templateId = BigInt(parseInt(jobTemplate.blockData.id, 16));
        jest.spyOn(templateProvider, 'getTemplate').mockReturnValue(undefined);
        sentFrames.length = 0;
        const coinbaseTx = createCoinbaseTransaction(templateProvider.buildCoinbaseHeightPrefix(jobTemplate.blockData.height));

        await (connection as any).handleFrame(
            Sv2MsgType.TDP_SUBMIT_SOLUTION,
            serializeTdpSubmitSolution({
                templateId,
                version: jobTemplate.block.version,
                headerTimestamp: jobTemplate.block.timestamp,
                headerNonce: 123,
                coinbaseTx: coinbaseTx.toBuffer(),
            }),
        );

        expect(bitcoinRpcService.SUBMIT_BLOCK).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]+$/));
        expect(blocksService.save).toHaveBeenCalledWith(expect.objectContaining({
            height: MockRecording1.BLOCK_TEMPLATE.height,
            blockSubmissionResult: null,
        }));
        expect(sentFrames.some(frame => frame.msgType === Sv2MsgType.TDP_REQUEST_TRANSACTION_DATA_ERROR)).toBe(false);
    });

    async function createConnection(): Promise<{
        connection: Sv2TemplateDistributionConnection;
        sentFrames: any[];
        templateProvider: TemplateProviderService;
        jobTemplate: any;
        bitcoinRpcService: { SUBMIT_BLOCK: jest.Mock };
        blocksService: { save: jest.Mock };
        payoutSnapshotService: { finalizeSnapshotForBlock: jest.Mock };
        notificationService: { notifySubscribersBlockFound: jest.Mock };
    }> {
        const blockTemplate$ = new BehaviorSubject(MockRecording1.BLOCK_TEMPLATE);
        const jobsService = new StratumV1JobsService({
            newBlockTemplate$: blockTemplate$.asObservable(),
            miningInfo: { blocks: MockRecording1.BLOCK_TEMPLATE.height },
        } as any);
        const jobTemplate = await firstValueFrom(jobsService.newMiningJob$);
        const templateProvider = new TemplateProviderService(jobsService);
        const bitcoinRpcService = {
            SUBMIT_BLOCK: jest.fn().mockResolvedValue(null),
        };
        const blocksService = {
            save: jest.fn().mockResolvedValue(undefined),
        };
        const payoutSnapshotService = {
            finalizeSnapshotForBlock: jest.fn().mockResolvedValue({ finalized: false, reason: 'disabled' }),
        };
        const notificationService = {
            notifySubscribersBlockFound: jest.fn().mockResolvedValue(undefined),
        };
        const socket = {
            setKeepAlive: jest.fn(),
            setNoDelay: jest.fn(),
            on: jest.fn(),
            write: jest.fn((data, callback) => callback?.()),
            destroy: jest.fn(),
            destroyed: false,
            writableEnded: false,
        };
        const connection = new Sv2TemplateDistributionConnection(
            socket as any,
            {
                getNoiseConfig: () => ({
                    staticKeypair: {
                        privateKey: Buffer.alloc(32),
                        publicKey: Buffer.alloc(64),
                    },
                    certificateMessage: {
                        version: 0,
                        validFrom: 0,
                        notValidAfter: 0,
                        signature: Buffer.alloc(64),
                    },
                }),
            } as any,
            jobsService,
            templateProvider,
            bitcoinRpcService as any,
            blocksService as any,
            payoutSnapshotService as any,
            notificationService as any,
            'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
            bitcoinjs.networks.testnet,
        );
        const sentFrames: any[] = [];
        (connection as any).sendFrame = jest.fn((msgType: number, payload: Buffer) => {
            sentFrames.push({ msgType, payload });
            return Promise.resolve();
        });
        return {
            connection,
            sentFrames,
            templateProvider,
            jobTemplate,
            bitcoinRpcService,
            blocksService,
            payoutSnapshotService,
            notificationService,
        };
    }

    function createCoinbaseTransaction(script: Buffer): bitcoinjs.Transaction {
        const tx = new bitcoinjs.Transaction();
        tx.version = 2;
        tx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, script);
        tx.addOutput(Buffer.from('6a', 'hex'), 0);
        return tx;
    }
});
