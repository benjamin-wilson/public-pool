import { Injectable } from '@nestjs/common';
import { BufferReader } from '../models/sv2/sv2-binary-codec';
import { Sv2SetCustomMiningJob } from '../models/sv2/sv2-jdp-messages';
import { DifficultyUtils } from '../utils/difficulty.utils';
import { hash256 } from '../utils/hash.utils';

export interface CustomWorkCoinbaseSplit {
    coinbasePrefix: Buffer;
    coinbaseSuffix: Buffer;
}

export interface CustomWorkShareValidationInput {
    coinbasePrefix: Buffer;
    coinbaseSuffix: Buffer;
    coinbaseTargetByteIndex?: number;
    coinbaseTargetByte?: number;
    merklePath: Buffer[];
    extranoncePrefix: Buffer;
    extranonce: Buffer;
    prevHash: Buffer;
    nBits: number;
    version: number;
    ntime: number;
    nonce: number;
    shareDifficulty: number;
    networkDifficulty: number;
}

export interface CustomWorkShareValidationResult {
    header: Buffer;
    merkleRoot: Buffer;
    hashBuffer: Buffer;
    submissionDifficulty: number;
    accepted: boolean;
    isBlockCandidate: boolean;
}

@Injectable()
export class CustomWorkService {
    public buildSv2CoinbaseSplit(job: Sv2SetCustomMiningJob, totalExtranonceSize: number): CustomWorkCoinbaseSplit {
        const scriptSigLen = job.coinbasePrefix.length + totalExtranonceSize;
        const scriptSigLenVarint = this.encodeBitcoinVarInt(scriptSigLen);

        const txVersion = Buffer.alloc(4);
        txVersion.writeUInt32LE(job.coinbaseTxVersion >>> 0, 0);

        const nullOutpoint = Buffer.alloc(36);
        nullOutpoint.writeUInt32LE(0xffffffff, 32);

        const sequence = Buffer.alloc(4);
        sequence.writeUInt32LE(job.coinbaseTxInputNSequence >>> 0, 0);

        const locktime = Buffer.alloc(4);
        locktime.writeUInt32LE(job.coinbaseTxLocktime >>> 0, 0);

        return {
            coinbasePrefix: Buffer.concat([
                txVersion,
                Buffer.from([0x01]),
                nullOutpoint,
                scriptSigLenVarint,
                job.coinbasePrefix,
            ]),
            coinbaseSuffix: Buffer.concat([
                sequence,
                job.coinbaseTxOutputs,
                locktime,
            ]),
        };
    }

    public validateShare(input: CustomWorkShareValidationInput): CustomWorkShareValidationResult {
        const coinbaseTx = Buffer.concat([
            input.coinbasePrefix,
            input.extranoncePrefix,
            input.extranonce,
            input.coinbaseSuffix,
        ]);
        if (input.coinbaseTargetByteIndex != null || input.coinbaseTargetByte != null) {
            if (input.coinbaseTargetByteIndex == null || input.coinbaseTargetByte == null) {
                throw new RangeError('Both coinbase target byte index and value are required');
            }
            if (input.coinbaseTargetByteIndex < 0 || input.coinbaseTargetByteIndex >= coinbaseTx.length) {
                throw new RangeError(`Coinbase target byte index ${input.coinbaseTargetByteIndex} is outside coinbase length ${coinbaseTx.length}`);
            }
            coinbaseTx[input.coinbaseTargetByteIndex] = input.coinbaseTargetByte & 0xff;
        }
        const merkleRoot = this.computeMerkleRoot(coinbaseTx, input.merklePath);
        const header = this.buildHeader(input.prevHash, merkleRoot, input.version, input.ntime, input.nBits, input.nonce);
        const { submissionDifficulty, hashBuffer } = DifficultyUtils.calculateDifficulty(header);

        return {
            header,
            merkleRoot,
            hashBuffer,
            submissionDifficulty,
            accepted: DifficultyUtils.meetsTarget(hashBuffer, DifficultyUtils.difficultyToTarget(input.shareDifficulty)),
            isBlockCandidate: DifficultyUtils.meetsTarget(hashBuffer, DifficultyUtils.difficultyToTarget(input.networkDifficulty)),
        };
    }

    public computeMerkleRoot(coinbaseTx: Buffer, merklePath: Buffer[]): Buffer {
        let merkleRoot = hash256(coinbaseTx);
        const pair = Buffer.alloc(64);
        for (const sibling of merklePath) {
            pair.fill(0);
            merkleRoot.copy(pair, 0);
            sibling.copy(pair, 32);
            merkleRoot = hash256(pair);
        }
        return merkleRoot;
    }

    public buildHeader(prevHash: Buffer, merkleRoot: Buffer, version: number, timestamp: number, nBits: number, nonce: number): Buffer {
        const header = Buffer.alloc(80);
        header.writeInt32LE(version, 0);
        prevHash.copy(header, 4);
        merkleRoot.copy(header, 36);
        header.writeUInt32LE(timestamp >>> 0, 68);
        header.writeUInt32LE(nBits >>> 0, 72);
        header.writeUInt32LE(nonce >>> 0, 76);
        return header;
    }

    public encodeBitcoinVarInt(value: number): Buffer {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new RangeError(`Invalid Bitcoin varint value ${value}`);
        }
        if (value < 0xfd) {
            return Buffer.from([value]);
        }
        if (value <= 0xffff) {
            const result = Buffer.alloc(3);
            result[0] = 0xfd;
            result.writeUInt16LE(value, 1);
            return result;
        }
        if (value <= 0xffffffff) {
            const result = Buffer.alloc(5);
            result[0] = 0xfe;
            result.writeUInt32LE(value, 1);
            return result;
        }
        const result = Buffer.alloc(9);
        result[0] = 0xff;
        result.writeBigUInt64LE(BigInt(value), 1);
        return result;
    }

    public readDatumNullTerminatedString(reader: BufferReader): string {
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
}
