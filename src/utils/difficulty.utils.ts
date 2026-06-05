import * as bitcoinjs from 'bitcoinjs-lib';

const TRUE_DIFF_ONE = 2.695953529101131e67;

export class DifficultyUtils {
  static calculateDifficulty(header: Buffer): { submissionDifficulty: number; submissionHash: string } {
    const hashResult = bitcoinjs.crypto.hash256(Buffer.isBuffer(header) ? header : Buffer.from(header, 'hex'));
    const target = DifficultyUtils.le256todouble(hashResult);
    const difficulty = target === 0 ? Number.POSITIVE_INFINITY : TRUE_DIFF_ONE / target;
    
    return { 
      submissionDifficulty: difficulty,
      submissionHash: hashResult.toString('hex') 
    };
  }

  private static le256todouble(target: Buffer): number {
    let number = 0;
    for (let i = target.length - 1; i >= 0; i--) {
      number = number * 256 + target[i];
    }
    return number;
  }
}
