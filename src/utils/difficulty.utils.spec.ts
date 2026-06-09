import { DifficultyUtils } from './difficulty.utils';

describe('DifficultyUtils', () => {
    function incrementLe256(target: Buffer): Buffer {
        const next = Buffer.from(target);
        for (let i = 0; i < next.length; i++) {
            next[i]++;
            if (next[i] !== 0) {
                break;
            }
        }
        return next;
    }

    it('round-trips common difficulty values through compact targets', () => {
        for (const difficulty of [0.001, 1, 128, 512, 1000, 1_000_000, 1_000_000_000, 1e30]) {
            const target = DifficultyUtils.difficultyToTarget(difficulty);
            const roundTrip = DifficultyUtils.targetToDifficulty(target);

            expect(Math.abs(roundTrip - difficulty) / difficulty).toBeLessThan(1e-12);
        }
    });

    it('compares little-endian targets without converting to BigInt', () => {
        const target = Buffer.alloc(32);
        target[0] = 0x80;
        target[30] = 0x01;
        const easier = Buffer.from(target);
        const harder = Buffer.from(target);

        easier[31] += 1;
        harder[0] -= 1;

        expect(DifficultyUtils.meetsTarget(target, target)).toBe(true);
        expect(DifficultyUtils.meetsTarget(harder, target)).toBe(true);
        expect(DifficultyUtils.meetsTarget(easier, target)).toBe(false);
    });

    it('calculates difficulty consistently with the returned hash buffer', () => {
        const header = Buffer.alloc(80, 1);
        const result = DifficultyUtils.calculateDifficulty(header);

        expect(result.submissionDifficulty).toBeCloseTo(
            DifficultyUtils.targetToDifficulty(result.hashBuffer),
            10,
        );
        expect(result.submissionHash).toBe(result.hashBuffer.toString('hex'));
    });

    it('keeps huge-difficulty boundary checks exact with target bytes', () => {
        const target = DifficultyUtils.difficultyToTarget(1e30);
        const justTooEasy = incrementLe256(target);

        expect(DifficultyUtils.targetToDifficulty(target)).toBeGreaterThan(1e29);
        expect(DifficultyUtils.meetsTarget(target, target)).toBe(true);
        expect(DifficultyUtils.meetsTarget(justTooEasy, target)).toBe(false);
    });

    it('treats a zero hash target as infinite reported difficulty', () => {
        expect(DifficultyUtils.targetToDifficulty(Buffer.alloc(32))).toBe(Number.POSITIVE_INFINITY);
    });
});
