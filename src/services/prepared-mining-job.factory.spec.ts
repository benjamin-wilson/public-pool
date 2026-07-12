import * as bitcoinjs from 'bitcoinjs-lib';
import * as crypto from 'crypto';
import * as merkle from 'merkle-lib';
import * as merkleProof from 'merkle-lib/proof';

import { MockRecording1 } from '../../test/models/MockRecording1';
import type { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { hash256 } from '../utils/hash.utils';
import {
  createPreparedMiningJob,
  PREPARED_JOB_BODY_CHECKSUM_ALGORITHM,
} from './prepared-mining-job.factory';

describe('prepared mining job factory', () => {
  it('prepares a compact full job from authoritative GBT fields', () => {
    const template = cloneTemplate();
    const prepared = createPreparedMiningJob(template);
    const parsedTransactions = template.transactions.map((transaction) =>
      bitcoinjs.Transaction.fromHex(transaction.data),
    );
    const expectedBody = checksumTemplateTransactions(template.transactions);

    expect(prepared).toEqual(
      expect.objectContaining({
        tipKey: `${template.height}:${template.previousblockhash}`,
        height: template.height,
        jobType: 'full',
        payoutMode: 'all',
        forceCleanJobs: false,
      }),
    );
    expect(prepared.header).toEqual({
      previousBlockHash: template.previousblockhash,
      previousBlockHashLE: Buffer.from(template.previousblockhash, 'hex')
        .reverse()
        .toString('hex'),
      version: template.version,
      bits: parseInt(template.bits, 16),
      bitsHex: template.bits,
      minTime: template.mintime,
      currentTime: template.curtime,
    });
    expect(prepared.coinbase).toEqual({
      valueSats: template.coinbasevalue,
      merkleBranch: expect.any(Array),
      witnessCommitmentHash: template.default_witness_commitment.slice(12, 76),
      payoutSnapshotId: undefined,
      payoutOutputs: undefined,
    });
    expect(prepared.body).toEqual({
      reference: `sha256:${expectedBody.checksum}`,
      checksum: expectedBody.checksum,
      checksumAlgorithm: PREPARED_JOB_BODY_CHECKSUM_ALGORITHM,
      transactionCount: parsedTransactions.length,
      byteLength: expectedBody.byteLength,
    });
    expect(prepared).not.toHaveProperty('transactions');
  });

  it('matches a bitcoinjs/merkle-lib branch and root for the full fixture', () => {
    const template = cloneTemplate();
    const prepared = createPreparedMiningJob(template);
    const coinbase = createPlaceholderCoinbase();
    const parsedTransactions = template.transactions.map((transaction) =>
      bitcoinjs.Transaction.fromHex(transaction.data),
    );
    const expected = buildBitcoinJsMerkleProof(coinbase, parsedTransactions);

    expect(prepared.coinbase.merkleBranch).toEqual(expected.branch);
    expect(
      applyCoinbaseMerkleBranch(
        coinbase.getHash(false),
        prepared.coinbase.merkleBranch,
      ),
    ).toEqual(expected.root);
    expect(expected.root).toEqual(
      bitcoinjs.Block.calculateMerkleRoot(
        [coinbase, ...parsedTransactions],
        false,
      ),
    );
    expect(
      template.transactions.map((transaction) => transaction.txid),
    ).toEqual(parsedTransactions.map((transaction) => transaction.getId()));
  });

  it('prepares an empty template with an empty branch and coinbase-only root', () => {
    const witnessCommitmentHash = hash256(Buffer.alloc(64)).toString('hex');
    const template = cloneTemplate({
      transactions: [],
      coinbasevalue: 312_500_000,
      default_witness_commitment: `6a24aa21a9ed${witnessCommitmentHash}`,
      forceCleanJobs: true,
      jobType: 'empty',
      payoutMode: 'solo',
    });
    const prepared = createPreparedMiningJob(template);
    const coinbase = createPlaceholderCoinbase();
    const emptyChecksum = crypto.createHash('sha256').digest('hex');

    expect(prepared.coinbase.merkleBranch).toEqual([]);
    expect(prepared.coinbase.witnessCommitmentHash).toBe(witnessCommitmentHash);
    expect(prepared.body).toEqual({
      reference: `sha256:${emptyChecksum}`,
      checksum: emptyChecksum,
      checksumAlgorithm: PREPARED_JOB_BODY_CHECKSUM_ALGORITHM,
      transactionCount: 0,
      byteLength: 0,
    });
    expect(prepared.jobType).toBe('empty');
    expect(prepared.payoutMode).toBe('solo');
    expect(prepared.forceCleanJobs).toBe(true);
    expect(
      applyCoinbaseMerkleBranch(
        coinbase.getHash(false),
        prepared.coinbase.merkleBranch,
      ),
    ).toEqual(bitcoinjs.Block.calculateMerkleRoot([coinbase], false));
  });

  it('builds the branch from txid even when data is not a parseable transaction', () => {
    const txid = '0123456789abcdef'.repeat(4);
    const template = cloneTemplate({
      transactions: [
        {
          ...MockRecording1.BLOCK_TEMPLATE.transactions[0],
          data: '00',
          txid,
        },
      ],
    });

    expect(() => bitcoinjs.Transaction.fromHex('00')).toThrow();
    expect(createPreparedMiningJob(template).coinbase.merkleBranch).toEqual([
      Buffer.from(txid, 'hex').reverse().toString('hex'),
    ]);
  });

  it('preserves payout and job modes while copying payout output objects', () => {
    const payoutOutputs = [
      { address: 'bc1qprepared-a', amountSats: 200_000_000 },
      { address: 'bc1qprepared-b', amountSats: 112_500_000 },
    ];
    const template = cloneTemplate({
      payoutMode: 'pplns',
      payoutSnapshotId: 'snapshot-42',
      payoutOutputs,
      jobType: 'empty',
      forceCleanJobs: true,
    });
    const prepared = createPreparedMiningJob(template);

    expect(prepared.payoutMode).toBe('pplns');
    expect(prepared.jobType).toBe('empty');
    expect(prepared.coinbase.payoutSnapshotId).toBe('snapshot-42');
    expect(prepared.coinbase.payoutOutputs).toEqual(payoutOutputs);
    expect(prepared.coinbase.payoutOutputs).not.toBe(payoutOutputs);
    expect(prepared.coinbase.payoutOutputs?.[0]).not.toBe(payoutOutputs[0]);
  });

  it('rejects malformed or incorrectly sized authoritative txids', () => {
    const original = MockRecording1.BLOCK_TEMPLATE.transactions[0];
    for (const txid of ['11'.repeat(31), '11'.repeat(33), 'zz'.repeat(32)]) {
      const template = cloneTemplate({
        transactions: [{ ...original, txid }],
      });
      expect(() => createPreparedMiningJob(template)).toThrow(
        /transactions\[0\]\.txid/,
      );
    }
  });

  it('validates and parses the BIP141 witness commitment length and prefix', () => {
    const commitmentHash = 'ab'.repeat(32);
    const commitment = `6a24aa21a9ed${commitmentHash}`;

    expect(
      createPreparedMiningJob(
        cloneTemplate({
          default_witness_commitment: `${commitment}cafe`,
        }),
      ).coinbase.witnessCommitmentHash,
    ).toBe(commitmentHash);

    for (const defaultWitnessCommitment of [
      `6a24aa21a9ed${'ab'.repeat(31)}`,
      `6a24aa21a9ee${commitmentHash}`,
      'zz'.repeat(38),
    ]) {
      expect(() =>
        createPreparedMiningJob(
          cloneTemplate({
            default_witness_commitment: defaultWitnessCommitment,
          }),
        ),
      ).toThrow(/default_witness_commitment/);
    }
  });

  it('defers raw body hex parsing while still requiring a non-empty byte-aligned body', () => {
    const original = MockRecording1.BLOCK_TEMPLATE.transactions[0];
    for (const data of ['', '0']) {
      expect(() =>
        createPreparedMiningJob(
          cloneTemplate({
            transactions: [{ ...original, data }],
          }),
        ),
      ).toThrow(/transactions\[0\]\.data/);
    }
    expect(() => createPreparedMiningJob(cloneTemplate({
      transactions: [{ ...original, data: 'zz' }],
    }))).not.toThrow();
  });
});

function cloneTemplate(
  overrides: Partial<IBlockTemplate> = {},
): IBlockTemplate {
  const template = MockRecording1.BLOCK_TEMPLATE;
  return {
    ...template,
    ...overrides,
    rules: [...(overrides.rules ?? template.rules)],
    vbavailable: { ...(overrides.vbavailable ?? template.vbavailable) },
    coinbaseaux: { ...(overrides.coinbaseaux ?? template.coinbaseaux) },
    mutable: [...(overrides.mutable ?? template.mutable)],
    capabilities: [...(overrides.capabilities ?? template.capabilities)],
    transactions: (overrides.transactions ?? template.transactions).map(
      (transaction) => ({
        ...transaction,
        depends: [...transaction.depends],
      }),
    ),
    payoutOutputs: (overrides.payoutOutputs ?? template.payoutOutputs)?.map(
      (output) => ({ ...output }),
    ),
  };
}

function createPlaceholderCoinbase(): bitcoinjs.Transaction {
  const coinbase = new bitcoinjs.Transaction();
  coinbase.version = 2;
  coinbase.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff);
  coinbase.ins[0].witness = [Buffer.alloc(32)];
  return coinbase;
}

function buildBitcoinJsMerkleProof(
  coinbase: bitcoinjs.Transaction,
  transactions: bitcoinjs.Transaction[],
): { branch: string[]; root: Buffer } {
  const hashes = [
    coinbase.getHash(false),
    ...transactions.map((transaction) => transaction.getHash(false)),
  ];
  const tree = merkle(hashes, hash256);
  const proof = merkleProof(tree, hashes[0]).filter(
    (hash): hash is Buffer => hash != null,
  );

  return {
    branch: proof.slice(1, -1).map((hash) => hash.toString('hex')),
    root: proof[proof.length - 1],
  };
}

function applyCoinbaseMerkleBranch(
  coinbaseHash: Buffer,
  branch: readonly string[],
): Buffer {
  return branch.reduce(
    (root, sibling) =>
      hash256(Buffer.concat([root, Buffer.from(sibling, 'hex')])),
    coinbaseHash,
  );
}

function checksumTemplateTransactions(
  transactions: IBlockTemplate['transactions'],
): {
  checksum: string;
  byteLength: number;
} {
  const checksum = crypto.createHash('sha256');
  let byteLength = 0;
  for (const transaction of transactions) {
    checksum.update(Buffer.from(transaction.txid, 'hex'));
    byteLength += transaction.data.length / 2;
  }
  return { checksum: checksum.digest('hex'), byteLength };
}
