import { CustomWorkService } from './custom-work.service';

describe('CustomWorkService', () => {
    const service = new CustomWorkService();

    it('builds SV2 custom-job coinbase splits around the extranonce', () => {
        const split = service.buildSv2CoinbaseSplit({
            channelId: 1,
            requestId: 2,
            token: Buffer.from('01', 'hex'),
            version: 0x20000000,
            prevHash: Buffer.alloc(32),
            minNtime: 1,
            nBits: 0x170fffff,
            coinbaseTxVersion: 2,
            coinbasePrefix: Buffer.from('51', 'hex'),
            coinbaseTxInputNSequence: 0xffffffff,
            coinbaseTxOutputs: Buffer.from('010000000000000000016a', 'hex'),
            coinbaseTxLocktime: 0,
            merklePath: [],
        }, 12);

        expect(split.coinbasePrefix.subarray(0, 4).toString('hex')).toBe('02000000');
        expect(split.coinbasePrefix.includes(Buffer.from([13]))).toBe(true);
        expect(split.coinbasePrefix.subarray(-1).toString('hex')).toBe('51');
        expect(split.coinbaseSuffix.subarray(0, 4).toString('hex')).toBe('ffffffff');
        expect(split.coinbaseSuffix.subarray(-4).toString('hex')).toBe('00000000');
    });

    it('encodes Bitcoin varints at boundary values', () => {
        expect(service.encodeBitcoinVarInt(0xfc).toString('hex')).toBe('fc');
        expect(service.encodeBitcoinVarInt(0xfd).toString('hex')).toBe('fdfd00');
        expect(service.encodeBitcoinVarInt(0xffff).toString('hex')).toBe('fdffff');
        expect(service.encodeBitcoinVarInt(0x10000).toString('hex')).toBe('fe00000100');
    });

    it('validates a trivial custom share against a very easy target', () => {
        const result = service.validateShare({
            coinbasePrefix: Buffer.from('0200000001000000000000000000000000000000000000000000000000000000000000000000000000ffffffff01', 'hex'),
            coinbaseSuffix: Buffer.from('ffffffff010000000000000000016a00000000', 'hex'),
            merklePath: [],
            extranoncePrefix: Buffer.alloc(4),
            extranonce: Buffer.alloc(8),
            prevHash: Buffer.alloc(32),
            nBits: 0x207fffff,
            version: 0x20000000,
            ntime: 1,
            nonce: 1,
            shareDifficulty: 0.00000001,
            networkDifficulty: Number.MAX_SAFE_INTEGER,
        });

        expect(result.header).toHaveLength(80);
        expect(result.merkleRoot).toHaveLength(32);
        expect(result.submissionDifficulty).toBeGreaterThan(0);
        expect(result.accepted).toBe(true);
        expect(result.isBlockCandidate).toBe(false);
    });

    it('patches DATUM coinbase target byte before computing the merkle root', () => {
        const baseInput = {
            coinbasePrefix: Buffer.from('02000000ff', 'hex'),
            coinbaseSuffix: Buffer.from('ffffffff010000000000000000016a00000000', 'hex'),
            merklePath: [],
            extranoncePrefix: Buffer.alloc(0),
            extranonce: Buffer.alloc(12),
            prevHash: Buffer.alloc(32),
            nBits: 0x207fffff,
            version: 0x20000000,
            ntime: 1,
            nonce: 1,
            shareDifficulty: 0.00000001,
            networkDifficulty: Number.MAX_SAFE_INTEGER,
        };

        const placeholder = service.validateShare(baseInput);
        const patched = service.validateShare({
            ...baseInput,
            coinbaseTargetByteIndex: 4,
            coinbaseTargetByte: 0x12,
        });
        const manuallyPatched = service.computeMerkleRoot(
            Buffer.concat([
                Buffer.from('0200000012', 'hex'),
                Buffer.alloc(12),
                baseInput.coinbaseSuffix,
            ]),
            [],
        );

        expect(patched.merkleRoot.equals(placeholder.merkleRoot)).toBe(false);
        expect(patched.merkleRoot.equals(manuallyPatched)).toBe(true);
    });
});
