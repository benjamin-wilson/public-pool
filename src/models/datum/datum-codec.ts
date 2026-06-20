import { BufferReader, BufferWriter } from '../sv2/sv2-binary-codec';

export const DATUM_PROTOCOL_VERSION = 'v0.4.1-beta';
export const DATUM_INITIAL_HEADER_KEY = 0xdc871829;
export const DATUM_MAX_PAYLOAD_SIZE = 4194304;
export const DATUM_MAX_JOBS = 8;
export const DATUM_EXTRANONCE_SIZE = 12;

export enum DatumProtocolCommand {
    PING = 0x01,
    HANDSHAKE_INIT = 0x01,
    HANDSHAKE_RESPONSE = 0x02,
    MINING = 0x05,
}

export enum DatumMiningCommand {
    FETCH_COINBASER = 0x10,
    FETCH_COINBASER_RESPONSE = 0x11,
    SUBMIT_POW = 0x27,
    JOB_VALIDATION = 0x50,
    SHARE_RESPONSE = 0x8f,
    CLIENT_CONFIGURE = 0x99,
    TEMPLATE_REFRESH = 0xf9,
}

export enum DatumJobValidationCommand {
    REQUEST_SHORT_TX_IDS = 0x10,
    REQUEST_FULL_TRANSACTIONS = 0x11,
    REQUEST_FULL_TRANSACTION_BLOB = 0x12,
    SHORT_TX_IDS_RESPONSE = 0x90,
    FULL_TRANSACTIONS_RESPONSE = 0x91,
    FULL_TRANSACTION_BLOB_RESPONSE = 0x92,
}

export enum DatumJobValidationStatus {
    SUCCESS = 0x01,
}

export enum DatumShareResponseStatus {
    ACCEPTED = 0x50,
    ACCEPTED_TENTATIVE = 0x55,
    REJECTED = 0x66,
}

export enum DatumRejectReason {
    BAD_JOB_ID = 10,
    BAD_COINBASE_ID = 11,
    BAD_EXTRANONCE_SIZE = 12,
    BAD_TARGET = 13,
    BAD_USERNAME = 14,
    BAD_COINBASER_ID = 15,
    BAD_MERKLE_COUNT = 16,
    BAD_COINBASE_TOO_LARGE = 17,
    COINBASE_MISSING = 18,
    TARGET_MISMATCH = 19,
    HIGH_HASH = 21,
    BAD_NTIME = 23,
    BAD_VERSION = 24,
    STALE_BLOCK = 25,
    DUPLICATE_WORK = 29,
    OTHER = 30,
}

export interface DatumHeader {
    cmdLen: number;
    reserved: number;
    isSigned: boolean;
    isEncryptedPubkey: boolean;
    isEncryptedChannel: boolean;
    protoCmd: number;
}

export interface DatumFrame {
    header: DatumHeader;
    payload: Buffer;
}

export interface DatumCoinbaserFetch {
    rewardValue: bigint;
}

export interface DatumPayoutOutput {
    value: bigint;
    scriptPubKey: Buffer;
}

export interface DatumPowSubmit {
    jobId: number;
    coinbaseId: number;
    isBlock: boolean;
    subsidyOnly: boolean;
    quickDiff: boolean;
    targetByte: number;
    ntime: number;
    nonce: number;
    version: number;
    extranonce: Buffer;
    username: string;
    reserved: Buffer;
    prevBlockHash?: Buffer;
    targetByteIndex?: number;
    nBits?: Buffer;
    coinbaserId?: number;
    height?: number;
    coinbaseValue?: bigint;
    transactionCount?: number;
    totalWeight?: number;
    totalSize?: number;
    totalSigops?: number;
    merkleBranches?: Buffer[];
    coinbasePairs: Map<number, { coinb1: Buffer; coinb2: Buffer }>;
    subsidyOnlyCoinbase?: { coinb1: Buffer; coinb2: Buffer };
}

export interface DatumShortTxIdsResponse {
    kind: 'short-txids';
    jobId: number;
    status: number;
    transactionCount: number;
    shortTxIds: Buffer[];
    crosscheck: Buffer | null;
}

export interface DatumFullTransactionsResponse {
    kind: 'full-transactions';
    jobId: number;
    status: number;
    transactionCount: number;
    transactions: Buffer[];
}

export interface DatumFullTransactionBlobResponse {
    kind: 'full-transaction-blob';
    jobId: number;
    status: number;
    transactionCount: number;
    transactions: Buffer[];
}

export type DatumJobValidationResponse =
    | DatumShortTxIdsResponse
    | DatumFullTransactionsResponse
    | DatumFullTransactionBlobResponse;

export function encodeDatumHeader(header: DatumHeader, xorKey = 0): Buffer {
    if (header.cmdLen < 0 || header.cmdLen > DATUM_MAX_PAYLOAD_SIZE - 1) {
        throw new RangeError(`DATUM payload length ${header.cmdLen} exceeds protocol limit`);
    }

    let raw = header.cmdLen & 0x3fffff;
    raw |= (header.reserved & 0x03) << 22;
    raw |= (header.isSigned ? 1 : 0) << 24;
    raw |= (header.isEncryptedPubkey ? 1 : 0) << 25;
    raw |= (header.isEncryptedChannel ? 1 : 0) << 26;
    raw |= (header.protoCmd & 0x1f) << 27;

    const out = Buffer.alloc(4);
    out.writeUInt32LE((raw ^ xorKey) >>> 0, 0);
    return out;
}

export function decodeDatumHeader(input: Buffer, xorKey = 0): DatumHeader {
    if (input.length < 4) {
        throw new RangeError('DATUM header requires 4 bytes');
    }
    const raw = (input.readUInt32LE(0) ^ xorKey) >>> 0;
    return {
        cmdLen: raw & 0x3fffff,
        reserved: (raw >>> 22) & 0x03,
        isSigned: ((raw >>> 24) & 0x01) !== 0,
        isEncryptedPubkey: ((raw >>> 25) & 0x01) !== 0,
        isEncryptedChannel: ((raw >>> 26) & 0x01) !== 0,
        protoCmd: (raw >>> 27) & 0x1f,
    };
}

export function datumHeaderXorFeedback(input: number): number {
    let h = 0xb10cfeed >>> 0;
    let k = input >>> 0;
    k = Math.imul(k, 0xcc9e2d51) >>> 0;
    k = (((k << 15) >>> 0) | (k >>> 17)) >>> 0;
    k = Math.imul(k, 0x1b873593) >>> 0;
    h = (h ^ k) >>> 0;
    h = (((h << 13) >>> 0) | (h >>> 19)) >>> 0;
    h = (Math.imul(h, 5) + 0xe6546b64) >>> 0;
    h = (h ^ 4) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h >>> 0;
}

export class DatumFrameReader {
    private buffer = Buffer.alloc(0);

    constructor(private headerXorKey = DATUM_INITIAL_HEADER_KEY) {}

    public setHeaderXorKey(headerXorKey: number): void {
        this.headerXorKey = headerXorKey >>> 0;
    }

    public feed(data: Buffer): DatumFrame[] {
        this.buffer = Buffer.concat([this.buffer, data]);
        const frames: DatumFrame[] = [];

        while (this.buffer.length >= 4) {
            const header = decodeDatumHeader(this.buffer.subarray(0, 4), this.headerXorKey);
            if (header.cmdLen > DATUM_MAX_PAYLOAD_SIZE) {
                throw new RangeError(`DATUM payload length ${header.cmdLen} exceeds protocol limit`);
            }
            if (this.buffer.length < 4 + header.cmdLen) {
                break;
            }

            frames.push({
                header,
                payload: Buffer.from(this.buffer.subarray(4, 4 + header.cmdLen)),
            });
            this.buffer = this.buffer.subarray(4 + header.cmdLen);
            if (header.isEncryptedChannel) {
                this.headerXorKey = datumHeaderXorFeedback(this.headerXorKey);
            }
        }

        return frames;
    }
}

export function encodeDatumFrame(frame: DatumFrame, xorKey = DATUM_INITIAL_HEADER_KEY): Buffer {
    return Buffer.concat([
        encodeDatumHeader({ ...frame.header, cmdLen: frame.payload.length }, xorKey),
        frame.payload,
    ]);
}

export function deserializeDatumMiningCommand(payload: Buffer): { command: DatumMiningCommand; body: Buffer } {
    if (payload.length < 1) {
        throw new RangeError('DATUM mining command requires a sub-command byte');
    }
    return {
        command: payload[0],
        body: Buffer.from(payload.subarray(1)),
    };
}

export function serializeDatumMiningCommand(command: DatumMiningCommand, body = Buffer.alloc(0)): Buffer {
    return Buffer.concat([Buffer.from([command]), body]);
}

export function serializeDatumJobValidationShortTxIdsRequest(jobId: number): Buffer {
    return serializeDatumMiningCommand(DatumMiningCommand.JOB_VALIDATION, Buffer.from([
        DatumJobValidationCommand.REQUEST_SHORT_TX_IDS,
        jobId & 0xff,
    ]));
}

export function serializeDatumJobValidationFullTransactionBlobRequest(jobId: number): Buffer {
    return serializeDatumMiningCommand(DatumMiningCommand.JOB_VALIDATION, Buffer.from([
        DatumJobValidationCommand.REQUEST_FULL_TRANSACTION_BLOB,
        jobId & 0xff,
    ]));
}

export function serializeDatumJobValidationFullTransactionsRequest(jobId: number, transactionIndexes: number[]): Buffer {
    if (transactionIndexes.length > 0xffff) {
        throw new RangeError('DATUM requested transaction index count must fit in u16');
    }
    const w = new BufferWriter();
    w.writeU8(DatumJobValidationCommand.REQUEST_FULL_TRANSACTIONS);
    w.writeU8(jobId);
    w.writeU16(transactionIndexes.length);
    for (const index of transactionIndexes) {
        if (!Number.isInteger(index) || index < 0 || index > 0xffff) {
            throw new RangeError(`Invalid DATUM transaction index ${index}`);
        }
        w.writeU16(index);
    }
    return serializeDatumMiningCommand(DatumMiningCommand.JOB_VALIDATION, Buffer.from(w.toBuffer()));
}

export function deserializeDatumJobValidationResponse(payload: Buffer): DatumJobValidationResponse {
    const reader = new BufferReader(payload);
    const responseCommand = reader.readU8();
    const jobId = reader.readU8();
    const status = reader.readU8();

    if (responseCommand === DatumJobValidationCommand.SHORT_TX_IDS_RESPONSE) {
        if (status !== DatumJobValidationStatus.SUCCESS) {
            return {
                kind: 'short-txids',
                jobId,
                status,
                transactionCount: 0,
                shortTxIds: [],
                crosscheck: null,
            };
        }
        const transactionCount = reader.readU16();
        const shortTxIds: Buffer[] = [];
        for (let i = 0; i < transactionCount; i++) {
            shortTxIds.push(reader.readBytes(6));
        }
        const crosscheck = reader.remaining >= 32 ? reader.readBytes(32) : null;
        consumeDatumTerminatorAndPadding(reader);
        return {
            kind: 'short-txids',
            jobId,
            status,
            transactionCount,
            shortTxIds,
            crosscheck,
        };
    }

    if (responseCommand === DatumJobValidationCommand.FULL_TRANSACTIONS_RESPONSE) {
        return deserializeDatumTransactionListResponse('full-transactions', reader, jobId, status);
    }

    if (responseCommand === DatumJobValidationCommand.FULL_TRANSACTION_BLOB_RESPONSE) {
        return deserializeDatumTransactionListResponse('full-transaction-blob', reader, jobId, status);
    }

    throw new RangeError(`Unsupported DATUM job validation response 0x${responseCommand.toString(16)}`);
}

export function deserializeDatumCoinbaserFetch(payload: Buffer): DatumCoinbaserFetch {
    if (payload.length < 8) {
        throw new RangeError('DATUM coinbaser fetch requires reward value');
    }
    return { rewardValue: payload.readBigUInt64LE(0) };
}

export function serializeDatumCoinbaserFetchResponse(rewardValue: bigint, outputs: DatumPayoutOutput[], coinbaserId = 1): Buffer {
    const w = new BufferWriter();
    w.writeU64(rewardValue);
    const outputsBuffer = serializeDatumPayoutOutputs(outputs, coinbaserId);
    w.writeU32(outputsBuffer.length);
    w.writeBytes(outputsBuffer);
    return serializeDatumMiningCommand(DatumMiningCommand.FETCH_COINBASER_RESPONSE, Buffer.from(w.toBuffer()));
}

export function serializeDatumPayoutOutputs(outputs: DatumPayoutOutput[], coinbaserId = 1): Buffer {
    if (!Number.isInteger(coinbaserId) || coinbaserId < 0 || coinbaserId > 255) {
        throw new RangeError('DATUM coinbaser id must fit in one byte');
    }
    const w = new BufferWriter();
    w.writeU8(coinbaserId);
    for (const output of outputs) {
        if (output.scriptPubKey.length > 255) {
            throw new RangeError('DATUM scriptPubKey length must fit in one byte');
        }
        w.writeU64(output.value);
        w.writeU8(output.scriptPubKey.length);
        w.writeBytes(output.scriptPubKey);
    }
    return w.toBuffer();
}

export function deserializeDatumPowSubmit(payload: Buffer): DatumPowSubmit {
    const reader = new BufferReader(payload);
    const jobId = reader.readU8();
    const coinbaseId = reader.readU8();
    const flags = reader.readU8();
    const targetByte = reader.readU8();
    const ntime = reader.readU32();
    const nonce = reader.readU32();
    const version = reader.readU32();
    const extranonceSize = reader.readU8();
    if (extranonceSize !== DATUM_EXTRANONCE_SIZE) {
        throw new RangeError(`Unsupported DATUM extranonce size ${extranonceSize}`);
    }
    const extranonce = reader.readBytes(extranonceSize);
    const username = readNullTerminatedString(reader);
    const reserved = reader.readBytes(Math.min(4, reader.remaining));
    const coinbasePairs = new Map<number, { coinb1: Buffer; coinb2: Buffer }>();
    const result: DatumPowSubmit = {
        jobId,
        coinbaseId,
        isBlock: (flags & 0x01) !== 0,
        subsidyOnly: (flags & 0x02) !== 0,
        quickDiff: (flags & 0x04) !== 0,
        targetByte,
        ntime,
        nonce,
        version,
        extranonce,
        username,
        reserved,
        coinbasePairs,
    };

    while (reader.remaining > 0) {
        const section = reader.readU8();
        if (section === 0xfe) {
            break;
        }
        if (section === 0x01) {
            result.prevBlockHash = reader.readBytes(32);
            result.targetByteIndex = reader.readU16();
            result.nBits = reader.readBytes(4);
            result.coinbaserId = reader.readU8();
            result.height = reader.readU32();
            result.coinbaseValue = reader.readU64();
            result.transactionCount = reader.readU32();
            result.totalWeight = reader.readU32();
            result.totalSize = reader.readU32();
            result.totalSigops = reader.readU32();
            const merkleBranchCount = reader.readU8();
            result.merkleBranches = [];
            for (let i = 0; i < merkleBranchCount; i++) {
                result.merkleBranches.push(reader.readBytes(32));
            }
            continue;
        }
        if (section === 0x02) {
            const coinbaseType = reader.readU8();
            const coinb1Len = reader.readU16();
            const coinb2Len = reader.readU16();
            const coinbase = {
                coinb1: reader.readBytes(coinb1Len),
                coinb2: reader.readBytes(coinb2Len),
            };
            if (coinbaseType === 255) {
                result.subsidyOnlyCoinbase = coinbase;
            } else {
                coinbasePairs.set(coinbaseType, coinbase);
            }
            continue;
        }
        throw new RangeError(`Unsupported DATUM POW section 0x${section.toString(16)}`);
    }

    return result;
}

export function serializeDatumShareResponse(input: {
    status: DatumShareResponseStatus;
    reasonCode: number;
    nonce: number;
    targetByte: number;
    jobId: number;
}): Buffer {
    const w = new BufferWriter();
    w.writeU8(input.status);
    w.writeU16(input.reasonCode);
    w.writeU32(input.nonce);
    w.writeU8(input.targetByte);
    w.writeU8(input.jobId);
    return serializeDatumMiningCommand(DatumMiningCommand.SHARE_RESPONSE, Buffer.from(w.toBuffer()));
}

function deserializeDatumTransactionListResponse(
    kind: 'full-transactions' | 'full-transaction-blob',
    reader: BufferReader,
    jobId: number,
    status: number,
): DatumFullTransactionsResponse | DatumFullTransactionBlobResponse {
    if (status !== DatumJobValidationStatus.SUCCESS) {
        return {
            kind,
            jobId,
            status,
            transactionCount: 0,
            transactions: [],
        };
    }

    const transactionCount = reader.readU16();
    const transactions: Buffer[] = [];
    for (let i = 0; i < transactionCount; i++) {
        const transactionSize = reader.readU24();
        transactions.push(reader.readBytes(transactionSize));
    }
    consumeDatumTerminatorAndPadding(reader);
    return {
        kind,
        jobId,
        status,
        transactionCount,
        transactions,
    };
}

function consumeDatumTerminatorAndPadding(reader: BufferReader): void {
    if (reader.remaining <= 0) {
        return;
    }
    const terminator = reader.readU8();
    if (terminator !== 0xfe) {
        throw new RangeError(`DATUM job validation response missing terminator; got 0x${terminator.toString(16)}`);
    }
}

function readNullTerminatedString(reader: BufferReader): string {
    const bytes: number[] = [];
    while (reader.remaining > 0) {
        const byte = reader.readU8();
        if (byte === 0) {
            break;
        }
        bytes.push(byte);
    }
    return Buffer.from(bytes).toString('utf8');
}
