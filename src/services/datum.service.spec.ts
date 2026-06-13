import { Socket } from 'net';
import { DatumProtocolCommand } from '../models/datum/datum-codec';
import { DatumService } from './datum.service';
import { TemplateProviderService } from './template-provider.service';

function createService(): DatumService {
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
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        templateProvider as unknown as TemplateProviderService,
        undefined,
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
});
