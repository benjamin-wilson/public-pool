import type { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import {
  calculateBlockSubsidySats,
  createSubsidyOnlyBlockTemplate,
  EMPTY_DEFAULT_WITNESS_COMMITMENT,
  EMPTY_WITNESS_COMMITMENT_HASH,
} from './subsidy-only-template.factory';

describe('subsidy-only template factory', () => {
  it('calculates mainnet subsidy at halving boundaries', () => {
    expect(calculateBlockSubsidySats(0, 'mainnet')).toBe(5_000_000_000);
    expect(calculateBlockSubsidySats(209_999, 'mainnet')).toBe(5_000_000_000);
    expect(calculateBlockSubsidySats(210_000, 'mainnet')).toBe(2_500_000_000);
    expect(calculateBlockSubsidySats(840_000, 'mainnet')).toBe(312_500_000);
    expect(calculateBlockSubsidySats(210_000 * 64, 'mainnet')).toBe(0);
  });

  it('uses the Bitcoin Core regtest halving interval', () => {
    expect(calculateBlockSubsidySats(149, 'regtest')).toBe(5_000_000_000);
    expect(calculateBlockSubsidySats(150, 'regtest')).toBe(2_500_000_000);
    expect(calculateBlockSubsidySats(300, 'regtest')).toBe(1_250_000_000);
  });

  it('accepts an explicit halving interval for custom chains', () => {
    expect(calculateBlockSubsidySats(20, 'mainnet', 10)).toBe(1_250_000_000);
  });

  it('rejects invalid candidate heights and halving intervals', () => {
    expect(() => calculateBlockSubsidySats(-1, 'mainnet')).toThrow(
      'Candidate height',
    );
    expect(() => calculateBlockSubsidySats(1.5, 'mainnet')).toThrow(
      'Candidate height',
    );
    expect(() => calculateBlockSubsidySats(1, 'mainnet', 0)).toThrow(
      'halving interval',
    );
  });

  it('builds a solo empty template while preserving authoritative header fields', () => {
    const authoritativeTemplate = createAuthoritativeTemplate();
    const originalTransaction = authoritativeTemplate.transactions[0];

    const result = createSubsidyOnlyBlockTemplate({
      authoritativeTemplate,
      network: 'mainnet',
      payoutMode: 'solo',
    });

    expect(result).toEqual(
      expect.objectContaining({
        version: authoritativeTemplate.version,
        bits: authoritativeTemplate.bits,
        previousblockhash: authoritativeTemplate.previousblockhash,
        mintime: authoritativeTemplate.mintime,
        height: authoritativeTemplate.height,
        coinbasevalue: 312_500_000,
        transactions: [],
        default_witness_commitment: EMPTY_DEFAULT_WITNESS_COMMITMENT,
        forceCleanJobs: true,
        jobType: 'empty',
        payoutMode: 'solo',
        payoutSnapshotId: undefined,
        payoutOutputs: undefined,
      }),
    );
    expect(authoritativeTemplate.transactions).toEqual([originalTransaction]);
    expect(authoritativeTemplate.coinbasevalue).toBe(312_512_345);
  });

  it('computes the empty-set BIP141 witness commitment', () => {
    expect(EMPTY_WITNESS_COMMITMENT_HASH).toBe(
      'e2f61c3f71d1defd3fa999dfa36953755c690689799962b48bebd836974e8cf9',
    );
    expect(EMPTY_DEFAULT_WITNESS_COMMITMENT).toBe(
      '6a24aa21a9ede2f61c3f71d1defd3fa999dfa36953755c690689799962b48bebd836974e8cf9',
    );
  });

  it('requires explicit PPLNS subsidy payout data instead of synthesizing a fallback', () => {
    expect(() =>
      createSubsidyOnlyBlockTemplate({
        authoritativeTemplate: createAuthoritativeTemplate(),
        network: 'mainnet',
        payoutMode: 'pplns',
      }),
    ).toThrow('explicit payout snapshot');
  });

  it('uses only the explicitly supplied PPLNS subsidy snapshot', () => {
    const authoritativeTemplate = createAuthoritativeTemplate();
    const result = createSubsidyOnlyBlockTemplate({
      authoritativeTemplate,
      network: 'mainnet',
      payoutMode: 'pplns',
      payoutSnapshot: {
        id: 'subsidy-snapshot',
        payoutOutputs: [
          { address: 'bc1qfirst', amountSats: 200_000_000 },
          { address: 'bc1qsecond', amountSats: 112_500_000 },
        ],
      },
    });

    expect(result.payoutSnapshotId).toBe('subsidy-snapshot');
    expect(result.payoutOutputs).toEqual([
      { address: 'bc1qfirst', amountSats: 200_000_000 },
      { address: 'bc1qsecond', amountSats: 112_500_000 },
    ]);
    expect(result.payoutOutputs).not.toBe(authoritativeTemplate.payoutOutputs);
    expect(result.payoutMode).toBe('pplns');
  });

  it('rejects PPLNS outputs that are not subsidy-valued fixed amounts', () => {
    const authoritativeTemplate = createAuthoritativeTemplate();

    expect(() =>
      createSubsidyOnlyBlockTemplate({
        authoritativeTemplate,
        network: 'mainnet',
        payoutMode: 'pplns',
        payoutSnapshot: {
          id: 'percentage-snapshot',
          payoutOutputs: [{ address: 'bc1qpercentage', percent: 100 }],
        },
      }),
    ).toThrow('amountSats');

    expect(() =>
      createSubsidyOnlyBlockTemplate({
        authoritativeTemplate,
        network: 'mainnet',
        payoutMode: 'pplns',
        payoutSnapshot: {
          id: 'overpaying-snapshot',
          payoutOutputs: [{ address: 'bc1qoverpaid', amountSats: 312_500_001 }],
        },
      }),
    ).toThrow('entire block subsidy');

    expect(() =>
      createSubsidyOnlyBlockTemplate({
        authoritativeTemplate,
        network: 'mainnet',
        payoutMode: 'pplns',
        payoutSnapshot: {
          id: 'underpaying-snapshot',
          payoutOutputs: [{ address: 'bc1qunderpaid', amountSats: 312_499_999 }],
        },
      }),
    ).toThrow('entire block subsidy');
  });
});

function createAuthoritativeTemplate(): IBlockTemplate {
  return {
    version: 0x20000000,
    rules: ['segwit'],
    vbavailable: {},
    vbrequired: 0,
    previousblockhash: '00'.repeat(32),
    transactions: [
      {
        data: '00',
        txid: '11'.repeat(32),
        hash: '22'.repeat(32),
        depends: [],
        fee: 12_345,
        sigops: 1,
        weight: 400,
      },
    ],
    coinbaseaux: {},
    coinbasevalue: 312_512_345,
    longpollid: 'longpoll',
    target: '00'.repeat(32),
    mintime: 1_700_000_000,
    mutable: ['time', 'transactions', 'prevblock'],
    noncerange: '00000000ffffffff',
    sigoplimit: 80_000,
    sizelimit: 4_000_000,
    weightlimit: 4_000_000,
    curtime: 1_700_000_001,
    bits: '170fffff',
    height: 840_000,
    default_witness_commitment: `6a24aa21a9ed${'33'.repeat(32)}`,
    capabilities: ['proposal'],
    payoutSnapshotId: 'full-template-snapshot',
    payoutOutputs: [{ address: 'bc1qfulltemplate', amountSats: 312_512_345 }],
    forceCleanJobs: false,
    jobType: 'full',
    payoutMode: 'all',
  };
}
