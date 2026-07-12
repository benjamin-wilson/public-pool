import { hash256 } from './hash.utils';

const TRUE_DIFF_ONE_BIGINT = BigInt(
    '26959535291011309493156476344723991336010898738574164086137773096960',
);
const TRUE_DIFF_ONE_NUMBER = 2.695953529101131e67;
const TWO_TO_256 = 1n << 256n;

export class DifficultyUtils {
    public static calculateDifficulty(header: Buffer): { submissionDifficulty: number; submissionHash: string; hashBuffer: Buffer } {
        const hashResult = hash256(header);
        const target = DifficultyUtils.le256ToDouble(hashResult);

        return {
            submissionDifficulty: target === 0 ? Number.POSITIVE_INFINITY : TRUE_DIFF_ONE_NUMBER / target,
            submissionHash: hashResult.toString('hex'),
            hashBuffer: hashResult,
        };
    }

    public static meetsTarget(hashBuffer: Buffer, target: Buffer): boolean {
        if (hashBuffer.length !== 32) {
            throw new Error('Hash must be 32 bytes');
        }
        if (target.length !== 32) {
            throw new Error('Target must be 32 bytes');
        }
        return DifficultyUtils.compareLe256(hashBuffer, target) <= 0;
    }

    /**
     * Decode Bitcoin's compact nBits value to the 32-byte little-endian target
     * representation used by raw double-SHA256 digests in this service.
     * Returns null for zero, negative, overflowing, or non-uint32 encodings.
     */
    public static compactToTarget(nBits: number): Buffer | null {
        if (!Number.isInteger(nBits) || nBits < 0 || nBits > 0xffffffff) {
            return null;
        }

        const size = nBits >>> 24;
        let word = nBits & 0x007fffff;
        if (size <= 3) {
            word >>>= 8 * (3 - size);
        }

        const negative = word !== 0 && (nBits & 0x00800000) !== 0;
        const overflow = word !== 0 && (
            size > 34
            || (word > 0xff && size > 33)
            || (word > 0xffff && size > 32)
        );
        if (word === 0 || negative || overflow) {
            return null;
        }

        const target = Buffer.alloc(32);
        const offset = size <= 3 ? 0 : size - 3;
        for (let byte = 0; byte < 3 && offset + byte < target.length; byte++) {
            target[offset + byte] = (word >>> (byte * 8)) & 0xff;
        }
        return target;
    }

    /**
     * Compare a raw, internal-byte-order block hash against a compact target.
     * Invalid nBits never match.
     */
    public static meetsCompactTarget(hashBuffer: Buffer, nBits: number): boolean {
        if (hashBuffer.length !== 32) {
            throw new Error('Hash must be 32 bytes');
        }

        const target = DifficultyUtils.compactToTarget(nBits);
        return target != null && DifficultyUtils.compareLe256(hashBuffer, target) <= 0;
    }

    public static difficultyToTarget(difficulty: number): Buffer {
        if (!Number.isFinite(difficulty) || difficulty <= 0) {
            return Buffer.alloc(32, 0xff);
        }

        const scale = 1_000_000n;
        const diffScaled = BigInt(Math.round(difficulty * Number(scale)));
        if (diffScaled === 0n) {
            return Buffer.alloc(32, 0xff);
        }

        return DifficultyUtils.bigIntToLe256((TRUE_DIFF_ONE_BIGINT * scale) / diffScaled);
    }

    public static targetToDifficulty(target: Buffer): number {
        if (target.length !== 32) {
            throw new Error('Target must be 32 bytes');
        }

        const targetNumber = DifficultyUtils.le256ToDouble(target);
        return targetNumber === 0 ? Number.POSITIVE_INFINITY : TRUE_DIFF_ONE_NUMBER / targetNumber;
    }

    public static hashRateToDifficulty(hashRate: number, sharesPerMinute: number): number {
        const target = DifficultyUtils.hashRateToTarget(hashRate, sharesPerMinute);
        return DifficultyUtils.targetToDifficulty(target);
    }

    public static clampDifficultyToMaxTarget(difficulty: number, maxTarget: Buffer): number {
        if (maxTarget.length !== 32) {
            return difficulty;
        }

        if (DifficultyUtils.isZeroTarget(maxTarget)) {
            return difficulty;
        }

        if (DifficultyUtils.compareLe256(DifficultyUtils.difficultyToTarget(difficulty), maxTarget) > 0) {
            const clamped = DifficultyUtils.targetToDifficulty(maxTarget);
            return Number.isFinite(clamped) && clamped > 0 ? clamped : difficulty;
        }

        return difficulty;
    }

    private static hashRateToTarget(hashRate: number, sharesPerMinute: number): Buffer {
        if (
            !Number.isFinite(hashRate)
            || hashRate <= 0
            || !Number.isFinite(sharesPerMinute)
            || sharesPerMinute <= 0
        ) {
            return Buffer.alloc(32, 0xff);
        }

        const secondsPerShare = 60 / sharesPerMinute;
        const hashesPerShare = BigInt(Math.round(hashRate * secondsPerShare));
        if (hashesPerShare === 0n) {
            return Buffer.alloc(32, 0xff);
        }

        const target = (TWO_TO_256 - hashesPerShare) / (hashesPerShare + 1n);
        return DifficultyUtils.bigIntToLe256(target);
    }

    private static bigIntToLe256(value: bigint): Buffer {
        const buf = Buffer.alloc(32);
        let remaining = value;
        for (let i = 0; i < 32; i++) {
            buf[i] = Number(remaining & 0xffn);
            remaining >>= 8n;
        }
        return buf;
    }

    private static le256ToDouble(target: Buffer): number {
        let value = 0;
        for (let i = target.length - 1; i >= 0; i--) {
            value = value * 256 + target[i];
        }
        return value;
    }

    private static compareLe256(left: Buffer, right: Buffer): number {
        for (let i = 31; i >= 0; i--) {
            const diff = left[i] - right[i];
            if (diff !== 0) {
                return diff;
            }
        }
        return 0;
    }

    private static isZeroTarget(target: Buffer): boolean {
        for (let i = 0; i < target.length; i++) {
            if (target[i] !== 0) {
                return false;
            }
        }
        return true;
    }
}
