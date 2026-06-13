import {
    DATUM_INITIAL_HEADER_KEY,
    DATUM_EXTRANONCE_SIZE,
    DatumFrameReader,
    DatumMiningCommand,
    DatumProtocolCommand,
    DatumShareResponseStatus,
    datumHeaderXorFeedback,
    decodeDatumHeader,
    deserializeDatumCoinbaserFetch,
    deserializeDatumJobValidationResponse,
    deserializeDatumMiningCommand,
    deserializeDatumPowSubmit,
    encodeDatumFrame,
    encodeDatumHeader,
    serializeDatumJobValidationFullTransactionBlobRequest,
    serializeDatumJobValidationFullTransactionsRequest,
    serializeDatumJobValidationShortTxIdsRequest,
    serializeDatumCoinbaserFetchResponse,
    serializeDatumMiningCommand,
    serializeDatumShareResponse,
} from './datum-codec';

describe('datum-codec', () => {
    it('round-trips DATUM packed headers with XOR key', () => {
        const encoded = encodeDatumHeader({
            cmdLen: 1234,
            reserved: 0,
            isSigned: true,
            isEncryptedPubkey: false,
            isEncryptedChannel: true,
            protoCmd: DatumProtocolCommand.MINING,
        }, DATUM_INITIAL_HEADER_KEY);

        expect(decodeDatumHeader(encoded, DATUM_INITIAL_HEADER_KEY)).toEqual({
            cmdLen: 1234,
            reserved: 0,
            isSigned: true,
            isEncryptedPubkey: false,
            isEncryptedChannel: true,
            protoCmd: DatumProtocolCommand.MINING,
        });
    });

    it('matches the DATUM header feedback function for stable inputs', () => {
        expect(datumHeaderXorFeedback(0).toString(16)).toBe('74a55cf6');
        expect(datumHeaderXorFeedback(0xdc871829).toString(16)).toBe('88e1697d');
    });

    it('splits framed DATUM payloads', () => {
        const first = encodeDatumFrame({
            header: {
                cmdLen: 0,
                reserved: 0,
                isSigned: false,
                isEncryptedPubkey: false,
                isEncryptedChannel: true,
                protoCmd: DatumProtocolCommand.MINING,
            },
            payload: serializeDatumMiningCommand(DatumMiningCommand.TEMPLATE_REFRESH),
        });
        const second = encodeDatumFrame({
            header: {
                cmdLen: 0,
                reserved: 0,
                isSigned: false,
                isEncryptedPubkey: false,
                isEncryptedChannel: true,
                protoCmd: DatumProtocolCommand.MINING,
            },
            payload: serializeDatumMiningCommand(DatumMiningCommand.FETCH_COINBASER, Buffer.alloc(8)),
        }, datumHeaderXorFeedback(DATUM_INITIAL_HEADER_KEY));

        const frames = new DatumFrameReader().feed(Buffer.concat([first, second]));
        expect(frames).toHaveLength(2);
        expect(deserializeDatumMiningCommand(frames[0].payload).command).toBe(DatumMiningCommand.TEMPLATE_REFRESH);
        expect(deserializeDatumMiningCommand(frames[1].payload).command).toBe(DatumMiningCommand.FETCH_COINBASER);
    });

    it('serializes coinbaser fetch responses', () => {
        const response = serializeDatumCoinbaserFetchResponse(50n, [
            { value: 50n, scriptPubKey: Buffer.from('6a', 'hex') },
        ]);
        const mining = deserializeDatumMiningCommand(response);
        expect(mining.command).toBe(DatumMiningCommand.FETCH_COINBASER_RESPONSE);
        expect(mining.body.readBigUInt64LE(0)).toBe(50n);
        expect(mining.body.readUInt32LE(8)).toBe(11);
    });

    it('deserializes coinbaser fetch requests', () => {
        const payload = Buffer.alloc(8);
        payload.writeBigUInt64LE(123n, 0);
        expect(deserializeDatumCoinbaserFetch(payload)).toEqual({ rewardValue: 123n });
    });

    it('deserializes fixed DATUM POW submissions', () => {
        const username = Buffer.from('bc1ptest.worker\0', 'utf8');
        const extranonce = Buffer.from('000102030405060708090a0b', 'hex');
        const payload = Buffer.alloc(17 + DATUM_EXTRANONCE_SIZE);
        payload[0] = 7;
        payload[1] = 1;
        payload[2] = 0x01;
        payload[3] = 4;
        payload.writeUInt32LE(100, 4);
        payload.writeUInt32LE(200, 8);
        payload.writeUInt32LE(0x20000000, 12);
        payload[16] = DATUM_EXTRANONCE_SIZE;
        extranonce.copy(payload, 17);
        const parsed = deserializeDatumPowSubmit(Buffer.concat([
            payload,
            username,
            Buffer.alloc(4),
            Buffer.from([0xfe]),
        ]));

        expect(parsed.jobId).toBe(7);
        expect(parsed.coinbaseId).toBe(1);
        expect(parsed.isBlock).toBe(true);
        expect(parsed.extranonce).toEqual(extranonce);
        expect(parsed.username).toBe('bc1ptest.worker');
    });

    it('deserializes cached DATUM POW context sections', () => {
        const username = Buffer.from('bc1ptest.worker\0', 'utf8');
        const extranonce = Buffer.from('000102030405060708090a0b', 'hex');
        const base = Buffer.alloc(17 + DATUM_EXTRANONCE_SIZE);
        base[0] = 3;
        base[1] = 2;
        base[2] = 0;
        base[3] = 0x12;
        base.writeUInt32LE(100, 4);
        base.writeUInt32LE(200, 8);
        base.writeUInt32LE(0x20000000, 12);
        base[16] = DATUM_EXTRANONCE_SIZE;
        extranonce.copy(base, 17);

        const templateSection = Buffer.concat([
            Buffer.from([0x01]),
            Buffer.alloc(32, 0xaa),
            Buffer.from([0x09, 0x00]),
            Buffer.from('ffff7f20', 'hex'),
            Buffer.from([7]),
            Buffer.from('64000000', 'hex'),
            Buffer.from('0100000000000000', 'hex'),
            Buffer.from('02000000', 'hex'),
            Buffer.from('03000000', 'hex'),
            Buffer.from('04000000', 'hex'),
            Buffer.from('05000000', 'hex'),
            Buffer.from([1]),
            Buffer.alloc(32, 0xbb),
        ]);
        const coinbaseSection = Buffer.concat([
            Buffer.from([0x02, 2]),
            Buffer.from([0x02, 0x00]),
            Buffer.from([0x03, 0x00]),
            Buffer.from('abcd', 'hex'),
            Buffer.from('010203', 'hex'),
        ]);

        const parsed = deserializeDatumPowSubmit(Buffer.concat([
            base,
            username,
            Buffer.alloc(4),
            templateSection,
            coinbaseSection,
            Buffer.from([0xfe]),
        ]));

        expect(parsed.jobId).toBe(3);
        expect(parsed.coinbaseId).toBe(2);
        expect(parsed.targetByte).toBe(0x12);
        expect(parsed.prevBlockHash?.equals(Buffer.alloc(32, 0xaa))).toBe(true);
        expect(parsed.targetByteIndex).toBe(9);
        expect(parsed.nBits?.toString('hex')).toBe('ffff7f20');
        expect(parsed.height).toBe(100);
        expect(parsed.merkleBranches?.[0].equals(Buffer.alloc(32, 0xbb))).toBe(true);
        expect(parsed.coinbasePairs.get(2)?.coinb1.toString('hex')).toBe('abcd');
        expect(parsed.coinbasePairs.get(2)?.coinb2.toString('hex')).toBe('010203');
    });

    it('rejects DATUM POW submissions with non-standard extranonce sizes', () => {
        const payload = Buffer.alloc(18);
        payload[16] = 1;
        payload[17] = 0xaa;

        expect(() => deserializeDatumPowSubmit(payload)).toThrow('Unsupported DATUM extranonce size 1');
    });

    it('serializes share responses', () => {
        const response = serializeDatumShareResponse({
            status: DatumShareResponseStatus.ACCEPTED,
            reasonCode: 0,
            nonce: 123,
            targetByte: 4,
            jobId: 7,
        });
        expect(response.toString('hex')).toBe('8f5000007b0000000407');
    });

    it('serializes DATUM job validation requests', () => {
        expect(serializeDatumJobValidationShortTxIdsRequest(7).toString('hex')).toBe('501007');
        expect(serializeDatumJobValidationFullTransactionBlobRequest(7).toString('hex')).toBe('501207');
        expect(serializeDatumJobValidationFullTransactionsRequest(7, [1, 258]).toString('hex')).toBe('501107020001000201');
    });

    it('deserializes DATUM short transaction ID validation responses', () => {
        const payload = Buffer.concat([
            Buffer.from([0x90, 7, 0x01]),
            Buffer.from('0200', 'hex'),
            Buffer.from('010203040506', 'hex'),
            Buffer.from('111213141516', 'hex'),
            Buffer.alloc(32, 0xaa),
            Buffer.from([0xfe, 0x00, 0x00]),
        ]);

        const parsed = deserializeDatumJobValidationResponse(payload);
        expect(parsed.kind).toBe('short-txids');
        expect(parsed.jobId).toBe(7);
        expect(parsed.status).toBe(1);
        expect(parsed.transactionCount).toBe(2);
        if (parsed.kind !== 'short-txids') {
            throw new Error(`Unexpected DATUM validation response kind ${parsed.kind}`);
        }
        expect(parsed.shortTxIds.map(id => id.toString('hex'))).toEqual(['010203040506', '111213141516']);
        expect(parsed.crosscheck?.equals(Buffer.alloc(32, 0xaa))).toBe(true);
    });

    it('deserializes DATUM full transaction blob validation responses', () => {
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
        const payload = Buffer.concat([
            Buffer.from([0x92, 9, 0x01]),
            Buffer.from('0100', 'hex'),
            txSize,
            tx,
            Buffer.from([0xfe]),
        ]);

        const parsed = deserializeDatumJobValidationResponse(payload);
        expect(parsed.kind).toBe('full-transaction-blob');
        expect(parsed.jobId).toBe(9);
        expect(parsed.status).toBe(1);
        expect(parsed.transactionCount).toBe(1);
        if (parsed.kind !== 'full-transaction-blob') {
            throw new Error(`Unexpected DATUM validation response kind ${parsed.kind}`);
        }
        expect(parsed.transactions[0]).toEqual(tx);
    });
});
