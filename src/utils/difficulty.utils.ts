import * as bitcoinjs from 'bitcoinjs-lib';

const TRUE_DIFF_ONE_BIGINT = BigInt(
    '26959535291011309493156476344723991336010898738574164086137773096960',
);
const TWO_TO_256 = 1n << 256n;
const FRACTION_SCALE = 1_000_000_000_000_000n;
const FRACTION_SCALE_NUM = 1e15;

function bigIntRatioToDifficulty(divisor: bigint): number {
    if (divisor === 0n) {
        return Number.POSITIVE_INFINITY;
    }

    const scaled = (TRUE_DIFF_ONE_BIGINT * FRACTION_SCALE) / divisor;
    return Number(scaled) / FRACTION_SCALE_NUM;
}

export class DifficultyUtils {
    public static calculateDifficulty(header: Buffer): { submissionDifficulty: number; submissionHash: string; hashBuffer: Buffer } {
        const hashResult = bitcoinjs.crypto.hash256(header);
        const target = DifficultyUtils.le256ToBigInt(hashResult);

        return {
            submissionDifficulty: bigIntRatioToDifficulty(target),
            submissionHash: hashResult.toString('hex'),
            hashBuffer: hashResult,
        };
    }

    public static meetsTarget(hashBuffer: Buffer, target: Buffer): boolean {
        return DifficultyUtils.le256ToBigInt(hashBuffer) <= DifficultyUtils.le256ToBigInt(target);
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

        const targetBigInt = DifficultyUtils.le256ToBigInt(target);
        return bigIntRatioToDifficulty(targetBigInt);
    }

    public static hashRateToDifficulty(hashRate: number, sharesPerMinute: number): number {
        const target = DifficultyUtils.hashRateToTarget(hashRate, sharesPerMinute);
        return DifficultyUtils.targetToDifficulty(target);
    }

    public static clampDifficultyToMaxTarget(difficulty: number, maxTarget: Buffer): number {
        if (maxTarget.length !== 32) {
            return difficulty;
        }

        const maxTargetBigInt = DifficultyUtils.le256ToBigInt(maxTarget);
        if (maxTargetBigInt === 0n) {
            return difficulty;
        }

        const computedTargetBigInt = DifficultyUtils.le256ToBigInt(
            DifficultyUtils.difficultyToTarget(difficulty),
        );
        if (computedTargetBigInt > maxTargetBigInt) {
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

    private static le256ToBigInt(target: Buffer): bigint {
        return target.reduceRight((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
    }
}
