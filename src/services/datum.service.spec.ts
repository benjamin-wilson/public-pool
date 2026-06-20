import { Socket } from 'net';
import * as bitcoinjs from 'bitcoinjs-lib';
import { DatumProtocolCommand } from '../models/datum/datum-codec';
import { DatumService } from './datum.service';
import { TemplateProviderService } from './template-provider.service';
import { StratumV1ClientStatistics } from '../models/StratumV1ClientStatistics';

function createService(overrides: {
    configService?: any;
    clientService?: any;
    redisMessagingService?: any;
} = {}): DatumService {
    const configService = overrides.configService ?? {
        get: jest.fn((key: string) => {
            if (key === 'NETWORK') {
                return 'testnet';
            }
            if (key === 'PAYOUT_COINBASE_MODE') {
                return 'snapshot';
            }
            return undefined;
        }),
    };
    const templateProvider = {
        validateTransactionData: jest.fn(({ transactionList, expectedCount, maxTotalBytes }) => {
            if (expectedCount != null && transactionList.length !== expectedCount) {
                return { valid: false, errorCode: 'transaction-count-mismatch' };
            }
            const totalBytes = transactionList.reduce((sum: number, tx: Buffer) => sum + tx.length, 0);
            if (maxTotalBytes != null && totalBytes > maxTotalBytes) {
                return { valid: false, errorCode: 'transaction-bytes-exceed-limit' };
            }
            return { valid: true, totalBytes };
        }),
    };
    return new DatumService(
        configService as any,
        {} as any,
        {} as any,
        overrides.clientService ?? {} as any,
        {} as any,
        {} as any,
        {} as any,
        templateProvider as unknown as TemplateProviderService,
        overrides.redisMessagingService,
    );
}

function createSocket(): Socket {
    return {
        destroyed: false,
        writableEnded: false,
        write: jest.fn((_data: Buffer, callback: (error?: Error) => void) => callback()),
    } as any;
}

function createState(cache: any): any {
    return {
        sessionId: 'datum-test',
        session: {
            encryptChannelFrame: jest.fn((_command: DatumProtocolCommand, payload: Buffer) => payload),
        },
        datumJobs: new Map([[7, cache]]),
    };
}

describe('DatumService job validation', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it('requests short transaction IDs once a DATUM job advertises transactions', async () => {
        const service = createService() as any;
        const socket = createSocket();
        const cache: any = {
            transactionCount: 2,
            coinbasePairs: new Map(),
        };
        const state = createState(cache);

        await service.maybeRequestDatumJobValidation(socket, state, 7, cache);

        expect(cache.validationState).toBe('requested-short-txids');
        expect((socket.write as jest.Mock).mock.calls[0][0].toString('hex')).toBe('501007');
        expect(state.session.encryptChannelFrame).toHaveBeenCalledWith(DatumProtocolCommand.MINING, expect.any(Buffer));
    });

    it('follows short transaction IDs with a full transaction blob request', async () => {
        const service = createService() as any;
        const socket = createSocket();
        const cache: any = {
            transactionCount: 1,
            coinbasePairs: new Map(),
        };
        const state = createState(cache);
        const shortIdsResponse = Buffer.concat([
            Buffer.from([0x90, 7, 0x01]),
            Buffer.from('0100', 'hex'),
            Buffer.from('010203040506', 'hex'),
            Buffer.alloc(32, 0xaa),
            Buffer.from([0xfe]),
        ]);

        await service.handleJobValidationResponse(socket, state, shortIdsResponse);

        expect(cache.validationState).toBe('requested-full-transaction-blob');
        expect(cache.validationShortTxIds.map((id: Buffer) => id.toString('hex'))).toEqual(['010203040506']);
        expect((socket.write as jest.Mock).mock.calls[0][0].toString('hex')).toBe('501207');
    });

    it('fails DATUM job validation when short transaction ID counts disagree', async () => {
        const service = createService() as any;
        const socket = createSocket();
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const cache: any = {
            transactionCount: 2,
            coinbasePairs: new Map(),
        };
        const state = createState(cache);
        const shortIdsResponse = Buffer.concat([
            Buffer.from([0x90, 7, 0x01]),
            Buffer.from('0100', 'hex'),
            Buffer.from('010203040506', 'hex'),
            Buffer.alloc(32, 0xaa),
            Buffer.from([0xfe]),
        ]);

        await service.handleJobValidationResponse(socket, state, shortIdsResponse);

        expect(cache.validationState).toBe('failed');
        expect(cache.validationError).toBe('short txid count mismatch: advertised 2, received 1');
        expect(socket.write).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('validates and caches full DATUM transaction blobs', async () => {
        const service = createService() as any;
        const socket = createSocket();
        const tx = Buffer.from(
            '0100000001'
            + '0000000000000000000000000000000000000000000000000000000000000000'
            + 'ffffffff00ffffffff'
            + '01000000000000000000'
            + '00000000',
            'hex',
        );
        const txSize = Buffer.alloc(3);
        txSize.writeUIntLE(tx.length, 0, 3);
        const cache: any = {
            transactionCount: 1,
            totalSize: tx.length,
            merkleBranches: [Buffer.alloc(32, 0xbb)],
            coinbasePairs: new Map(),
        };
        const state = createState(cache);
        const fullBlobResponse = Buffer.concat([
            Buffer.from([0x92, 7, 0x01]),
            Buffer.from('0100', 'hex'),
            txSize,
            tx,
            Buffer.from([0xfe]),
        ]);

        await service.handleJobValidationResponse(socket, state, fullBlobResponse);

        expect(cache.validationState).toBe('validated');
        expect(cache.validationTransactions).toEqual([tx]);
        expect(cache.validationError).toBeUndefined();
        expect((service as any).templateProvider.validateTransactionData).toHaveBeenCalledWith({
            transactionList: [tx],
            expectedCount: 1,
            maxTotalBytes: tx.length,
            expectedCoinbaseMerklePath: [Buffer.alloc(32, 0xbb)],
        });
        expect(socket.write).not.toHaveBeenCalled();
    });

    it('publishes DATUM client presence with smoothed hashrate after accepted shares', async () => {
        jest.useFakeTimers().setSystemTime(new Date('2026-06-13T15:00:00.000Z'));
        const clientService = {
            updateBestDifficultyIfHigher: jest.fn().mockResolvedValue(undefined),
            updateHashRate: jest.fn().mockResolvedValue(undefined),
        };
        const redisMessagingService = {
            setClientPresence: jest.fn().mockResolvedValue(undefined),
        };
        const service = createService({ clientService, redisMessagingService }) as any;
        const state = {
            sessionId: 'datum-session',
            userAgent: 'datum/test',
            clientEntity: {
                id: '3db0db03-3a62-4e3b-91bc-243adff4b542',
                address: 'tb1qdatum',
                clientName: 'datum-worker',
                sessionId: 'datum-session',
                startTime: new Date('2026-06-13T14:59:00.000Z'),
                bestDifficulty: 0,
                hashRate: 0,
            },
            statistics: new StratumV1ClientStatistics(1),
            lastHashRatePersistedAt: 0,
        };

        await service.updateAcceptedSharePresence(state, 'tb1qdatum', 'datum-worker', 10, 1);
        jest.setSystemTime(new Date('2026-06-13T15:00:31.000Z'));
        await service.updateAcceptedSharePresence(state, 'tb1qdatum', 'datum-worker', 20, 1);
        jest.setSystemTime(new Date('2026-06-13T15:01:02.000Z'));
        await service.updateAcceptedSharePresence(state, 'tb1qdatum', 'datum-worker', 30, 1);

        expect(clientService.updateBestDifficultyIfHigher).toHaveBeenLastCalledWith(
            '3db0db03-3a62-4e3b-91bc-243adff4b542',
            30,
        );
        expect(redisMessagingService.setClientPresence).toHaveBeenLastCalledWith(expect.objectContaining({
            clientId: '3db0db03-3a62-4e3b-91bc-243adff4b542',
            address: 'tb1qdatum',
            clientName: 'datum-worker',
            sessionId: 'datum-session',
            hashRate: expect.any(Number),
            bestDifficulty: 30,
        }));
        const lastPresence = redisMessagingService.setClientPresence.mock.calls.at(-1)[0];
        expect(lastPresence.hashRate).toBeGreaterThan(0);
        expect(state.clientEntity.hashRate).toBe(lastPresence.hashRate);
        expect(clientService.updateHashRate).toHaveBeenCalledWith(
            '3db0db03-3a62-4e3b-91bc-243adff4b542',
            lastPresence.hashRate,
            new Date('2026-06-13T15:01:02.000Z'),
        );
    });

    it('derives submitted share difficulty from DATUM target byte', () => {
        const service = createService() as any;

        expect(service.getDatumSubmittedShareDifficulty({ targetByte: 0x00 })).toBe(1);
        expect(service.getDatumSubmittedShareDifficulty({ targetByte: 0x0e })).toBe(16_384);
        expect(service.getDatumSubmittedShareDifficulty({ targetByte: 0x14 })).toBe(1_048_576);
    });

    it('falls back to configured DATUM share difficulty for invalid target bytes', () => {
        const service = createService({
            configService: {
                get: jest.fn((key: string) => {
                    if (key === 'DATUM_SHARE_DIFFICULTY') {
                        return '4096';
                    }
                    if (key === 'NETWORK') {
                        return 'testnet';
                    }
                    return undefined;
                }),
            },
        }) as any;

        expect(service.getDatumSubmittedShareDifficulty({ targetByte: 0xff })).toBe(4096);
    });

    it('accepts DATUM coinbases that exactly match snapshot payout outputs', () => {
        const service = createService() as any;
        const extranonce = Buffer.alloc(12, 1);
        const expectedOutputs = [
            { address: 'tb1q42vtlphyjjcun9wcv9f0d9pkhup9dcf5z9k4gh', amountSats: 421 },
            { address: 'tb1q9r8gvnx3j4d6jvl0fqjrmy3dar4k4l3052af7q', amountSats: 133 },
            { address: 'tb1qdyjakeepue4trak9d3hvyelrd0aw7mwju2d0c2', amountSats: 42 },
        ];
        const coinbase = createDatumCoinbaseSplit(expectedOutputs, extranonce);
        const latestTemplate = {
            blockData: {
                coinbasevalue: 596,
                payoutOutputs: expectedOutputs,
            },
        };

        expect(service.validateDatumCoinbasePayouts(
            coinbase,
            { extranonce, targetByte: 0 },
            latestTemplate,
            596n,
            undefined,
            'pplns',
        ).valid).toBe(true);
    });

    it('accepts DATUM coinbases with zero-value OP_RETURN metadata plus matching snapshot payouts', () => {
        const service = createService() as any;
        const extranonce = Buffer.alloc(12, 1);
        const expectedOutputs = [
            { address: 'tb1q42vtlphyjjcun9wcv9f0d9pkhup9dcf5z9k4gh', amountSats: 421 },
            { address: 'tb1q9r8gvnx3j4d6jvl0fqjrmy3dar4k4l3052af7q', amountSats: 133 },
            { address: 'tb1qdyjakeepue4trak9d3hvyelrd0aw7mwju2d0c2', amountSats: 42 },
        ];
        const coinbase = createDatumCoinbaseSplit(expectedOutputs, extranonce, true);
        const latestTemplate = {
            blockData: {
                coinbasevalue: 596,
                payoutOutputs: expectedOutputs,
            },
        };

        const validation = service.validateDatumCoinbasePayouts(
            coinbase,
            { extranonce, targetByte: 0 },
            latestTemplate,
            596n,
            undefined,
            'pplns',
        );

        expect(validation.valid).toBe(true);
        expect(validation.submittedOutputs).toHaveLength(3);
    });

    it('rejects DATUM coinbases with extra spendable outputs beyond snapshot payouts', () => {
        const service = createService() as any;
        const extranonce = Buffer.alloc(12, 1);
        const expectedOutputs = [
            { address: 'tb1q42vtlphyjjcun9wcv9f0d9pkhup9dcf5z9k4gh', amountSats: 421 },
            { address: 'tb1q9r8gvnx3j4d6jvl0fqjrmy3dar4k4l3052af7q', amountSats: 133 },
            { address: 'tb1qdyjakeepue4trak9d3hvyelrd0aw7mwju2d0c2', amountSats: 42 },
        ];
        const coinbase = createDatumCoinbaseSplit([
            ...expectedOutputs,
            { address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', amountSats: 1 },
        ], extranonce);
        const latestTemplate = {
            blockData: {
                coinbasevalue: 596,
                payoutOutputs: expectedOutputs,
            },
        };

        const validation = service.validateDatumCoinbasePayouts(
            coinbase,
            { extranonce, targetByte: 0 },
            latestTemplate,
            596n,
            undefined,
            'pplns',
        );

        expect(validation.valid).toBe(false);
        expect(validation.error).toBe('output-count-mismatch');
    });

    it('rejects DATUM coinbases that do not pay the pool snapshot outputs', () => {
        const service = createService() as any;
        const extranonce = Buffer.alloc(12, 1);
        const expectedOutputs = [
            { address: 'tb1q42vtlphyjjcun9wcv9f0d9pkhup9dcf5z9k4gh', amountSats: 421 },
            { address: 'tb1q9r8gvnx3j4d6jvl0fqjrmy3dar4k4l3052af7q', amountSats: 133 },
            { address: 'tb1qdyjakeepue4trak9d3hvyelrd0aw7mwju2d0c2', amountSats: 42 },
        ];
        const maliciousCoinbase = createDatumCoinbaseSplit([
            { address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', amountSats: 596 },
        ], extranonce);
        const latestTemplate = {
            blockData: {
                coinbasevalue: 596,
                payoutOutputs: expectedOutputs,
            },
        };

        expect(service.validateDatumCoinbasePayouts(
            maliciousCoinbase,
            { extranonce, targetByte: 0 },
            latestTemplate,
            596n,
            undefined,
            'pplns',
        ).valid).toBe(false);
    });

    it('validates DATUM coinbases against the coinbaser-id payout outputs instead of the latest template', () => {
        const service = createService() as any;
        const extranonce = Buffer.alloc(12, 1);
        const fetchedOutputs = [
            { address: 'tb1q42vtlphyjjcun9wcv9f0d9pkhup9dcf5z9k4gh', amountSats: 596 },
        ];
        const laterTemplateOutputs = [
            { address: 'tb1q9r8gvnx3j4d6jvl0fqjrmy3dar4k4l3052af7q', amountSats: 596 },
        ];
        const coinbase = createDatumCoinbaseSplit(fetchedOutputs, extranonce);
        const latestTemplate = {
            blockData: {
                coinbasevalue: 596,
                payoutOutputs: laterTemplateOutputs,
            },
        };
        const expectedPayoutOutputs = (service as any).getDatumPayoutOutputs({
            blockData: {
                payoutOutputs: fetchedOutputs,
            },
        }, 596, 'pplns');

        expect(service.validateDatumCoinbasePayouts(
            coinbase,
            { extranonce, targetByte: 0 },
            latestTemplate,
            596n,
            expectedPayoutOutputs,
            'pplns',
        ).valid).toBe(true);
    });

    it('carries the coinbaser payout snapshot id into the DATUM job cache', () => {
        const service = createService() as any;
        const payoutOutputs = [{
            value: 596n,
            scriptPubKey: bitcoinjs.address.toOutputScript(
                'tb1q42vtlphyjjcun9wcv9f0d9pkhup9dcf5z9k4gh',
                bitcoinjs.networks.testnet,
            ),
        }];
        const state = {
            datumJobs: new Map(),
            coinbaserPayoutContexts: new Map([[9, {
                payoutOutputs,
                payoutSnapshotId: '95',
                blockHeight: 4991366,
            }]]),
        };

        const cache = service.updateDatumJobCache(state, {
            jobId: 7,
            coinbaserId: 9,
            coinbasePairs: new Map(),
        });

        expect(cache.coinbaserId).toBe(9);
        expect(cache.expectedPayoutOutputs).toBe(payoutOutputs);
        expect(cache.payoutSnapshotId).toBe('95');
    });
});

function createDatumCoinbaseSplit(
    outputs: { address: string; amountSats: number }[],
    extranonce: Buffer,
    includeDatumMetadata = false,
): { coinb1: Buffer; coinb2: Buffer } {
    const tx = new bitcoinjs.Transaction();
    tx.version = 2;
    tx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff);
    tx.ins[0].script = Buffer.concat([
        Buffer.from([0x03, 0x51, 0x27, 0x4c]),
        extranonce,
    ]);
    tx.ins[0].witness = [Buffer.alloc(32)];
    for (const output of outputs) {
        tx.addOutput(
            bitcoinjs.address.toOutputScript(output.address, bitcoinjs.networks.testnet),
            output.amountSats,
        );
    }
    if (includeDatumMetadata) {
        tx.addOutput(bitcoinjs.script.compile([bitcoinjs.opcodes.OP_RETURN, Buffer.from([0])]), 0);
    }
    tx.addOutput(
        bitcoinjs.script.compile([
            bitcoinjs.opcodes.OP_RETURN,
            Buffer.concat([Buffer.from('aa21a9ed', 'hex'), Buffer.alloc(32, 2)]),
        ]),
        0,
    );

    const serialized = tx.toBuffer();
    const index = serialized.indexOf(extranonce);
    if (index < 0) {
        throw new Error('test coinbase split missing extranonce');
    }
    return {
        coinb1: serialized.subarray(0, index),
        coinb2: serialized.subarray(index + extranonce.length),
    };
}
