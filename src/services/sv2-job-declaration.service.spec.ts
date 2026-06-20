import * as bitcoinjs from 'bitcoinjs-lib';

import { BufferReader } from '../models/sv2/sv2-binary-codec';
import { Sv2JdpSetupFlags, Sv2MsgType, Sv2Protocol } from '../models/sv2/sv2-constants';
import {
    deserializeAllocateMiningJobTokenSuccess,
    deserializeDeclareMiningJobError,
    deserializeDeclareMiningJobSuccess,
    deserializeProvideMissingTransactions,
    serializeAllocateMiningJobToken,
    serializeDeclareMiningJob,
    serializeProvideMissingTransactionsSuccess,
    serializePushSolution,
} from '../models/sv2/sv2-jdp-messages';
import {
    deserializeSetupConnectionSuccess,
    serializeSetupConnection,
} from '../models/sv2/sv2-messages';
import { Sv2JobDeclarationConnection } from './sv2-job-declaration.service';
import { Sv2JobDeclarationRegistryService } from './sv2-job-declaration-registry.service';

describe('Sv2JobDeclarationConnection compliance', () => {
    it('does not echo Job Declaration setup flags in SetupConnection.Success', async () => {
        const { connection, sentFrames } = createConnection();

        await (connection as any).handleSetupConnection(serializeSetupConnection({
            protocol: Sv2Protocol.JOB_DECLARATION,
            minVersion: 2,
            maxVersion: 2,
            flags: Sv2JdpSetupFlags.DECLARE_TX_DATA,
            endpoint_host: 'localhost',
            endpoint_port: 34264,
            vendor: 'jd-client',
            hardwareVersion: '',
            firmwareVersion: '',
            deviceId: '',
        }));

        const successFrame = sentFrames.find(frame => frame.msgType === Sv2MsgType.SETUP_CONNECTION_SUCCESS);
        const success = deserializeSetupConnectionSuccess(new BufferReader(successFrame.payload));
        expect(success.flags).toBe(0);
        expect(success.usedVersion).toBe(2);
    });

    it('rejects DeclareMiningJob unless DECLARE_TX_DATA was negotiated', async () => {
        const { connection, sentFrames, registry } = createConnection();

        await (connection as any).handleDeclareMiningJob(serializeDeclareMiningJob({
            requestId: 9,
            miningJobToken: Buffer.from('aa', 'hex'),
            version: 0x20000000,
            coinbaseTxPrefix: Buffer.alloc(0),
            coinbaseTxSuffix: Buffer.alloc(0),
            wtxidList: [],
            excessData: Buffer.alloc(0),
        }));

        const errorFrame = sentFrames.find(frame => frame.msgType === Sv2MsgType.JDP_DECLARE_MINING_JOB_ERROR);
        const error = deserializeDeclareMiningJobError(new BufferReader(errorFrame.payload));
        expect(error.requestId).toBe(9);
        expect(error.errorCode).toBe('declare-tx-data-not-negotiated');
        expect(registry.declareJob).not.toHaveBeenCalled();
    });

    it('allocates a zero-value JDP token output while fixed payouts remain in the template', async () => {
        const registry = new Sv2JobDeclarationRegistryService();
        const payoutOutputs = [
            { address: 'tb1q42vtlphyjjcun9wcv9f0d9pkhup9dcf5z9k4gh', amountSats: 391 },
            { address: 'tb1q9r8gvnx3j4d6jvl0fqjrmy3dar4k4l3052af7q', amountSats: 110 },
            { address: 'tb1qdyjakeepue4trak9d3hvyelrd0aw7mwju2d0c2', amountSats: 95 },
        ];
        const { connection, sentFrames } = createConnection({
            registry,
            templateProvider: {
                getLatestTemplate: jest.fn().mockReturnValue({
                    jobTemplate: {
                        blockData: {
                            coinbasevalue: 596,
                            payoutOutputs,
                        },
                    },
                }),
            },
        });

        await (connection as any).handleAllocateMiningJobToken(serializeAllocateMiningJobToken({
            requestId: 7,
            userIdentifier: 'tb1qdyjakeepue4trak9d3hvyelrd0aw7mwju2d0c2.sri-jdc',
        }));

        const successFrame = sentFrames.find(frame => frame.msgType === Sv2MsgType.JDP_ALLOCATE_MINING_JOB_TOKEN_SUCCESS);
        const success = deserializeAllocateMiningJobTokenSuccess(new BufferReader(successFrame.payload));

        expect(success.requestId).toBe(7);
        const tokenOutputs = readSerializedTxOutputs(success.coinbaseOutputs);
        expect(tokenOutputs).toHaveLength(1);
        expect(tokenOutputs[0].value).toBe(0);
        expect(bitcoinjs.address.fromOutputScript(tokenOutputs[0].script, bitcoinjs.networks.testnet))
            .toBe('tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4');
    });

    it('accepts DeclareMiningJob when all wtxids are known to the template provider', async () => {
        const registry = new Sv2JobDeclarationRegistryService();
        const allocated = registry.allocateToken('bc1ptest.worker', Buffer.alloc(0));
        const coinbaseTxPrefix = Buffer.from('010203', 'hex');
        const validateDeclaredWtxids = jest.fn().mockReturnValue({
            valid: true,
            template: { templateId: 42n },
        });
        const { connection, sentFrames } = createConnection({
            registry,
            templateProvider: {
                validateDeclaredWtxids,
            },
        });
        (connection as any).declareTxData = true;

        await (connection as any).handleDeclareMiningJob(serializeDeclareMiningJob({
            requestId: 10,
            miningJobToken: allocated.token,
            version: 0x20000000,
            coinbaseTxPrefix,
            coinbaseTxSuffix: Buffer.alloc(0),
            wtxidList: [Buffer.alloc(32, 1)],
            excessData: Buffer.alloc(0),
        }));

        const successFrame = sentFrames.find(frame => frame.msgType === Sv2MsgType.JDP_DECLARE_MINING_JOB_SUCCESS);
        const success = deserializeDeclareMiningJobSuccess(new BufferReader(successFrame.payload));
        expect(success.requestId).toBe(10);
        expect(registry.getDeclaredJob(success.newMiningJobToken)?.validationMode).toBe('full_template');
        expect(registry.getDeclaredJob(success.newMiningJobToken)?.template).toEqual({ templateId: 42n });
        expect(validateDeclaredWtxids).toHaveBeenCalledWith({
            version: 0x20000000,
            coinbaseTxPrefix,
            wtxidList: [Buffer.alloc(32, 1)],
        });
    });

    it('rejects DeclareMiningJob when the declared coinbase prefix fails BIP34 validation', async () => {
        const registry = new Sv2JobDeclarationRegistryService();
        const allocated = registry.allocateToken('bc1ptest.worker', Buffer.alloc(0));
        const { connection, sentFrames } = createConnection({
            registry,
            templateProvider: {
                validateDeclaredWtxids: jest.fn().mockReturnValue({
                    valid: false,
                    errorCode: 'invalid-job-param-value-coinbase_tx_prefix',
                    template: { templateId: 42n },
                }),
            },
        });
        (connection as any).declareTxData = true;

        await (connection as any).handleDeclareMiningJob(serializeDeclareMiningJob({
            requestId: 12,
            miningJobToken: allocated.token,
            version: 0x20000000,
            coinbaseTxPrefix: Buffer.from('/public-pool-sri-jdc-e2e/', 'utf8'),
            coinbaseTxSuffix: Buffer.alloc(0),
            wtxidList: [],
            excessData: Buffer.alloc(0),
        }));

        const errorFrame = sentFrames.find(frame => frame.msgType === Sv2MsgType.JDP_DECLARE_MINING_JOB_ERROR);
        const error = deserializeDeclareMiningJobError(new BufferReader(errorFrame.payload));
        expect(error.requestId).toBe(12);
        expect(error.errorCode).toBe('invalid-job-param-value-coinbase_tx_prefix');
        expect(registry.getDeclaredJob(allocated.token)).toBeUndefined();
    });

    it('requests missing transactions and finalizes after valid missing transaction response', async () => {
        const registry = new Sv2JobDeclarationRegistryService();
        const allocated = registry.allocateToken('bc1ptest.worker', Buffer.alloc(0));
        const templateProvider = {
            validateDeclaredWtxids: jest.fn().mockReturnValue({
                valid: false,
                errorCode: 'missing-transactions',
                template: { templateId: 42n },
                unknownTxPositionList: [1],
            }),
            validateProvidedTransactions: jest.fn().mockReturnValue({ valid: true }),
        };
        const { connection, sentFrames } = createConnection({ registry, templateProvider });
        (connection as any).declareTxData = true;

        await (connection as any).handleDeclareMiningJob(serializeDeclareMiningJob({
            requestId: 11,
            miningJobToken: allocated.token,
            version: 0x20000000,
            coinbaseTxPrefix: Buffer.alloc(0),
            coinbaseTxSuffix: Buffer.alloc(0),
            wtxidList: [Buffer.alloc(32, 1), Buffer.alloc(32, 2)],
            excessData: Buffer.alloc(0),
        }));

        const missingFrame = sentFrames.find(frame => frame.msgType === Sv2MsgType.JDP_PROVIDE_MISSING_TRANSACTIONS);
        const missing = deserializeProvideMissingTransactions(new BufferReader(missingFrame.payload));
        expect(missing.requestId).toBe(11);
        expect(missing.unknownTxPositionList).toEqual([1]);

        await (connection as any).handleProvideMissingTransactionsSuccess(serializeProvideMissingTransactionsSuccess({
            requestId: 11,
            transactionList: [Buffer.from('0100000000', 'hex')],
        }));

        const successFrame = sentFrames.find(frame => frame.msgType === Sv2MsgType.JDP_DECLARE_MINING_JOB_SUCCESS);
        const success = deserializeDeclareMiningJobSuccess(new BufferReader(successFrame.payload));
        expect(registry.getDeclaredJob(success.newMiningJobToken)?.providedTransactions).toEqual([Buffer.from('0100000000', 'hex')]);
        expect(registry.getDeclaredJob(success.newMiningJobToken)?.template).toEqual({ templateId: 42n });
    });

    it('submits PushSolution before persisting the found block', async () => {
        const block = createMockBlock('deadbeef');
        const templateProvider = {
            getTemplate: jest.fn().mockReturnValue({
                height: 4990255,
                jobTemplate: {
                    blockData: {
                        payoutSnapshotId: '17',
                    },
                },
            }),
            buildBlockFromDeclaredJobSolution: jest.fn().mockReturnValue(block),
        };
        const callOrder: string[] = [];
        const bitcoinRpcService = {
            SUBMIT_BLOCK: jest.fn().mockImplementation(async () => {
                callOrder.push('submit');
                return null;
            }),
        };
        const blocksService = {
            save: jest.fn().mockImplementation(async () => {
                callOrder.push('save');
            }),
        };
        const payoutSnapshotService = {
            finalizeSnapshotForBlock: jest.fn().mockResolvedValue({ finalized: false, reason: 'disabled' }),
        };
        const notificationService = {
            notifySubscribersBlockFound: jest.fn().mockResolvedValue(undefined),
        };
        const { connection } = createConnection({
            templateProvider,
            bitcoinRpcService,
            blocksService,
            payoutSnapshotService,
            notificationService,
            payoutMode: 'pplns',
        });
        (connection as any).latestDeclaredJob = {
            token: Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
            userIdentifier: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker1',
            job: { requestId: 1 } as any,
            templateId: 42n,
            validationMode: 'full_template',
            providedTransactions: [],
        };

        await (connection as any).handlePushSolution(serializePushSolution({
            extranonce: Buffer.from('aabbccdd', 'hex'),
            prevHash: Buffer.alloc(32, 1),
            nonce: 1,
            ntime: 2,
            nBits: 0x1d00ffff,
            version: 0x20000000,
        }));

        expect(bitcoinRpcService.SUBMIT_BLOCK).toHaveBeenCalledWith('deadbeef');
        expect(blocksService.save).toHaveBeenCalledWith(expect.objectContaining({
            height: 4990255,
            minerAddress: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
            worker: 'worker1',
            sessionId: '01234567',
            blockData: 'deadbeef',
            payoutSnapshotId: '17',
        }));
        expect(callOrder).toEqual(['submit', 'save']);
        expect(payoutSnapshotService.finalizeSnapshotForBlock).toHaveBeenCalledWith({
            payoutSnapshotId: '17',
            blockHeight: 4990255,
            blockSubmissionResult: null,
            payoutMode: 'pplns',
        });
        expect(notificationService.notifySubscribersBlockFound).toHaveBeenCalledWith(
            'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
            4990255,
            block,
            null,
        );
    });

    it('submits PushSolution using the declared template snapshot after template cache cleanup', async () => {
        const block = createMockBlock('feedface');
        const declaredTemplate = {
            height: 4990300,
            jobTemplate: {
                blockData: {
                    payoutSnapshotId: '23',
                },
            },
        };
        const templateProvider = {
            getTemplate: jest.fn().mockReturnValue(undefined),
            getLatestTemplate: jest.fn().mockReturnValue(undefined),
            buildBlockFromDeclaredJobSolution: jest.fn().mockReturnValue(block),
        };
        const bitcoinRpcService = {
            SUBMIT_BLOCK: jest.fn().mockResolvedValue('SUCCESS!'),
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
        const { connection } = createConnection({
            templateProvider,
            bitcoinRpcService,
            blocksService,
            payoutSnapshotService,
            notificationService,
            payoutMode: 'pplns',
        });
        (connection as any).latestDeclaredJob = {
            token: Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
            userIdentifier: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker1',
            job: { requestId: 1 } as any,
            templateId: 42n,
            template: declaredTemplate,
            validationMode: 'full_template',
            providedTransactions: [],
        };

        await (connection as any).handlePushSolution(serializePushSolution({
            extranonce: Buffer.from('aabbccdd', 'hex'),
            prevHash: Buffer.alloc(32, 1),
            nonce: 1,
            ntime: 2,
            nBits: 0x1d00ffff,
            version: 0x20000000,
        }));

        expect(templateProvider.getTemplate).not.toHaveBeenCalled();
        expect(templateProvider.buildBlockFromDeclaredJobSolution).toHaveBeenCalledWith(expect.objectContaining({
            template: declaredTemplate,
        }));
        expect(bitcoinRpcService.SUBMIT_BLOCK).toHaveBeenCalledWith('feedface');
        expect(blocksService.save).toHaveBeenCalledWith(expect.objectContaining({
            height: 4990300,
            blockSubmissionResult: 'SUCCESS!',
            payoutSnapshotId: '23',
        }));
    });

    it('does not resubmit duplicate PushSolution messages', async () => {
        const block = createMockBlock('feedface');
        const templateProvider = {
            buildBlockFromDeclaredJobSolution: jest.fn().mockReturnValue(block),
        };
        const bitcoinRpcService = {
            SUBMIT_BLOCK: jest.fn().mockResolvedValue('SUCCESS!'),
        };
        const { connection } = createConnection({
            templateProvider,
            bitcoinRpcService,
            blocksService: { save: jest.fn().mockResolvedValue(undefined) },
        });
        (connection as any).latestDeclaredJob = {
            token: Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
            userIdentifier: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker1',
            job: { requestId: 1 } as any,
            template: {
                height: 4990300,
                jobTemplate: { blockData: { payoutSnapshotId: null } },
            },
            validationMode: 'full_template',
            providedTransactions: [],
        };
        const payload = serializePushSolution({
            extranonce: Buffer.from('aabbccdd', 'hex'),
            prevHash: Buffer.alloc(32, 1),
            nonce: 1,
            ntime: 2,
            nBits: 0x1d00ffff,
            version: 0x20000000,
        });

        await (connection as any).handlePushSolution(payload);
        await (connection as any).handlePushSolution(payload);

        expect(bitcoinRpcService.SUBMIT_BLOCK).toHaveBeenCalledTimes(1);
    });

    it('does not submit PushSolution blocks with a coinbase missing the BIP34 height', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const invalidBlock = createBlockWithCoinbaseScript(Buffer.from('/public-pool-sri-jdc-e2e/', 'utf8'));
        const templateProvider = {
            buildBlockFromDeclaredJobSolution: jest.fn().mockReturnValue(invalidBlock),
            validateCoinbaseTransactionHeight: jest.fn().mockReturnValue({
                valid: false,
                errorCode: 'invalid-job-param-value-coinbase_tx_prefix',
            }),
        };
        const bitcoinRpcService = {
            SUBMIT_BLOCK: jest.fn().mockResolvedValue('SUCCESS!'),
        };
        const blocksService = {
            save: jest.fn().mockResolvedValue(undefined),
        };
        const { connection } = createConnection({
            templateProvider,
            bitcoinRpcService,
            blocksService,
        });
        (connection as any).latestDeclaredJob = {
            token: Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
            userIdentifier: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker1',
            job: { requestId: 1 } as any,
            template: {
                height: 4990300,
                jobTemplate: { blockData: { payoutSnapshotId: null } },
            },
            validationMode: 'full_template',
            providedTransactions: [],
        };

        await (connection as any).handlePushSolution(serializePushSolution({
            extranonce: Buffer.from('aabbccdd', 'hex'),
            prevHash: Buffer.alloc(32, 1),
            nonce: 1,
            ntime: 2,
            nBits: 0x1d00ffff,
            version: 0x20000000,
        }));

        expect(bitcoinRpcService.SUBMIT_BLOCK).not.toHaveBeenCalled();
        expect(blocksService.save).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid-job-param-value-coinbase_tx_prefix'));
        warn.mockRestore();
    });

    function createConnection(overrides: {
        registry?: any;
        templateProvider?: any;
        bitcoinRpcService?: any;
        blocksService?: any;
        payoutSnapshotService?: any;
        notificationService?: any;
        payoutMode?: 'solo' | 'pplns';
    } = {}): {
        connection: Sv2JobDeclarationConnection;
        sentFrames: any[];
        registry: { allocateToken: jest.Mock; declareJob: jest.Mock };
    } {
        const socket = {
            setKeepAlive: jest.fn(),
            setNoDelay: jest.fn(),
            on: jest.fn(),
            write: jest.fn((data, callback) => callback?.()),
            destroy: jest.fn(),
            destroyed: false,
            writableEnded: false,
        };
        const registry = overrides.registry ?? {
            allocateToken: jest.fn(),
            declareJob: jest.fn(),
        };
        const templateProvider = {
            getLatestTemplate: jest.fn().mockReturnValue(undefined),
            buildCoinbasePayoutOutputs: jest.fn((payoutInformation, coinbaseValue, network) => {
                let balance = BigInt(coinbaseValue);
                const outputs = payoutInformation.map(recipient => {
                    const value = recipient.amountSats == null
                        ? BigInt(Math.floor(((recipient.percent ?? 0) / 100) * Number(coinbaseValue)))
                        : BigInt(recipient.amountSats);
                    balance -= value;
                    return {
                        value,
                        scriptPubKey: bitcoinjs.address.toOutputScript(recipient.address, network),
                    };
                });
                if (outputs.length > 0 && balance !== 0n) {
                    outputs[0] = { ...outputs[0], value: outputs[0].value + balance };
                }
                return outputs;
            }),
            validateDeclaredWtxids: jest.fn().mockReturnValue({ valid: false, errorCode: 'template-not-found' }),
            validateProvidedTransactions: jest.fn().mockReturnValue({ valid: false, errorCode: 'template-not-found' }),
            validateCoinbaseTransactionHeight: jest.fn().mockReturnValue({ valid: true }),
            ...overrides.templateProvider,
        };
        const connection = new Sv2JobDeclarationConnection(
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
            registry as any,
            {
                encodeBitcoinVarInt: encodeBitcoinVarIntForTest,
            } as any,
            templateProvider,
            overrides.bitcoinRpcService ?? {
                SUBMIT_BLOCK: jest.fn().mockResolvedValue(null),
            },
            overrides.blocksService ?? {
                save: jest.fn().mockResolvedValue(undefined),
            },
            overrides.payoutSnapshotService ?? {
                finalizeSnapshotForBlock: jest.fn().mockResolvedValue({ finalized: false, reason: 'disabled' }),
            },
            overrides.notificationService ?? {
                notifySubscribersBlockFound: jest.fn().mockResolvedValue(undefined),
            },
            'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
            bitcoinjs.networks.testnet,
            overrides.payoutMode ?? 'solo',
        );
        const sentFrames: any[] = [];
        (connection as any).sendFrame = jest.fn((msgType: number, payload: Buffer) => {
            sentFrames.push({ msgType, payload });
            return Promise.resolve();
        });
        return { connection, sentFrames, registry: registry as any };
    }

    function createBlockWithCoinbaseScript(script: Buffer): bitcoinjs.Block {
        const tx = new bitcoinjs.Transaction();
        tx.version = 2;
        tx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, script);
        tx.addOutput(Buffer.from('6a', 'hex'), 0);

        const block = new bitcoinjs.Block();
        block.version = 0x20000000;
        block.prevHash = Buffer.alloc(32);
        block.timestamp = 2;
        block.bits = 0x1d00ffff;
        block.nonce = 1;
        block.transactions = [tx];
        block.merkleRoot = bitcoinjs.Block.calculateMerkleRoot(block.transactions, false);
        return block;
    }

    function createMockBlock(hex: string): { toHex: jest.Mock; transactions: Array<{ toBuffer: jest.Mock }> } {
        return {
            toHex: jest.fn().mockReturnValue(hex),
            transactions: [{
                toBuffer: jest.fn().mockReturnValue(Buffer.from('0100000000', 'hex')),
            }],
        };
    }

    function readSerializedTxOutputs(outputs: Buffer): bitcoinjs.TxOutput[] {
        const tx = bitcoinjs.Transaction.fromBuffer(Buffer.concat([
            Buffer.from('0200000001', 'hex'),
            Buffer.alloc(32),
            Buffer.from('ffffffff00ffffffff', 'hex'),
            outputs,
            Buffer.from('00000000', 'hex'),
        ]));
        return tx.outs;
    }

    function encodeBitcoinVarIntForTest(value: number): Buffer {
        if (value < 0xfd) {
            return Buffer.from([value]);
        }
        if (value <= 0xffff) {
            const result = Buffer.alloc(3);
            result[0] = 0xfd;
            result.writeUInt16LE(value, 1);
            return result;
        }
        throw new RangeError(`Unsupported test varint ${value}`);
    }
});
