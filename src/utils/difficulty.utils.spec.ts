import { DifficultyUtils } from './difficulty.utils';
import { hash256 } from './hash.utils';

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

    it('decodes compact targets from Bitcoin mainnet examples into little-endian bytes', () => {
        const examples = [
            {
                nBits: 0x1d00ffff,
                target: '00000000ffff0000000000000000000000000000000000000000000000000000',
            },
            {
                nBits: 0x181bc330,
                target: '00000000000000001bc330000000000000000000000000000000000000000000',
            },
            {
                nBits: 0x1a44b9f2,
                target: '00000000000044b9f20000000000000000000000000000000000000000000000',
            },
        ];

        for (const example of examples) {
            const target = DifficultyUtils.compactToTarget(example.nBits);

            expect(target).not.toBeNull();
            expect(Buffer.from(target).reverse().toString('hex')).toBe(example.target);
        }
    });

    it('matches Bitcoin Core compact decoding for exponents at or below three', () => {
        const examples = [
            { nBits: 0x01123456, target: 0x12 },
            { nBits: 0x02008000, target: 0x80 },
            { nBits: 0x03009234, target: 0x9234 },
            { nBits: 0x05009234, target: 0x92340000 },
        ];

        for (const example of examples) {
            const expected = Buffer.alloc(32);
            expected.writeUInt32LE(example.target, 0);
            expect(DifficultyUtils.compactToTarget(example.nBits)).toEqual(expected);
        }
    });

    it('matches known Bitcoin mainnet header hashes using internal hash byte order', () => {
        const examples = [
            {
                nBits: 0x1d00ffff,
                header: [
                    '01000000',
                    '0000000000000000000000000000000000000000000000000000000000000000',
                    '3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a',
                    '29ab5f49',
                    'ffff001d',
                    '1dac2b7c',
                ].join(''),
                internalHash: '6fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000',
            },
            {
                nBits: 0x1a44b9f2,
                header: [
                    '01000000',
                    '81cd02ab7e569e8bcd9317e2fe99f2de44d49ab2b8851ba4a308000000000000',
                    'e320b6c2fffc8d750423db8b1eb942ae710e951ed797f7affc8892b0f1fc122b',
                    'c7f5d74d',
                    'f2b9441a',
                    '42a14695',
                ].join(''),
                internalHash: '1dbd981fe6985776b644b173a4d0385ddc1aa2a829688d1e0000000000000000',
            },
        ];

        for (const example of examples) {
            const hash = hash256(Buffer.from(example.header, 'hex'));

            expect(hash.toString('hex')).toBe(example.internalHash);
            expect(DifficultyUtils.meetsCompactTarget(hash, example.nBits)).toBe(true);
            expect(DifficultyUtils.meetsCompactTarget(Buffer.from(hash).reverse(), example.nBits)).toBe(false);
        }
    });

    it('compares compact targets exactly at the little-endian boundary', () => {
        const nBits = 0x1d00ffff;
        const target = DifficultyUtils.compactToTarget(nBits);
        expect(target).not.toBeNull();

        expect(DifficultyUtils.meetsCompactTarget(target, nBits)).toBe(true);
        expect(DifficultyUtils.meetsCompactTarget(incrementLe256(target), nBits)).toBe(false);
        expect(DifficultyUtils.meetsCompactTarget(Buffer.alloc(32), nBits)).toBe(true);
    });

    it('rejects negative compact targets using Bitcoin Core sign semantics', () => {
        for (const nBits of [0x04923456, 0x1d80ffff]) {
            expect(DifficultyUtils.compactToTarget(nBits)).toBeNull();
            expect(DifficultyUtils.meetsCompactTarget(Buffer.alloc(32), nBits)).toBe(false);
        }
    });

    it('rejects all compact target overflow forms at the 256-bit boundary', () => {
        for (const nBits of [
            0x23000001,
            0x22000100,
            0x21010000,
        ]) {
            expect(DifficultyUtils.compactToTarget(nBits)).toBeNull();
            expect(DifficultyUtils.meetsCompactTarget(Buffer.alloc(32), nBits)).toBe(false);
        }

        const size34Boundary = DifficultyUtils.compactToTarget(0x220000ff);
        const size33Boundary = DifficultyUtils.compactToTarget(0x2100ffff);
        expect(size34Boundary).not.toBeNull();
        expect(size33Boundary).not.toBeNull();
        expect(Buffer.from(size34Boundary).reverse().toString('hex')).toBe(`ff${'00'.repeat(31)}`);
        expect(Buffer.from(size33Boundary).reverse().toString('hex')).toBe(`ffff${'00'.repeat(30)}`);
    });

    it('rejects zero targets and values outside an unsigned 32-bit nBits field', () => {
        for (const nBits of [
            0,
            0x01003456,
            -1,
            0x1_0000_0000,
            1.5,
            Number.NaN,
        ]) {
            expect(DifficultyUtils.compactToTarget(nBits)).toBeNull();
            expect(DifficultyUtils.meetsCompactTarget(Buffer.alloc(32), nBits)).toBe(false);
        }
    });

    it('rejects ambiguous hash or target buffer lengths', () => {
        expect(() => DifficultyUtils.meetsTarget(
            Buffer.alloc(31),
            Buffer.alloc(32),
        )).toThrow('Hash must be 32 bytes');
        expect(() => DifficultyUtils.meetsTarget(
            Buffer.alloc(32),
            Buffer.alloc(31),
        )).toThrow('Target must be 32 bytes');
        expect(() => DifficultyUtils.meetsCompactTarget(
            Buffer.alloc(33),
            0x1d00ffff,
        )).toThrow('Hash must be 32 bytes');
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
