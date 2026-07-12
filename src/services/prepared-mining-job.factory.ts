import * as crypto from 'crypto';

import type {
  IBlockTemplate,
  IBlockTemplatePayoutOutput,
  IBlockTemplateTx,
} from '../models/bitcoin-rpc/IBlockTemplate';
import type { PayoutMode } from '../types/payout-mode';
import { hash256 } from '../utils/hash.utils';

const WITNESS_COMMITMENT_PREFIX = '6a24aa21a9ed';
const HASH_BYTES = 32;
const UINT32_MAX = 0xffffffff;
const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;

export const PREPARED_JOB_BODY_CHECKSUM_ALGORITHM =
  'sha256-txids-v1' as const;

export interface PreparedMiningJobHeader {
  /** Display/RPC byte order, normalized to lowercase hex. */
  previousBlockHash: string;
  /** Internal header byte order, normalized to lowercase hex. */
  previousBlockHashLE: string;
  version: number;
  bits: number;
  bitsHex: string;
  minTime: number;
  currentTime: number;
}

export interface PreparedMiningJobCoinbase {
  valueSats: number;
  /** Internal-byte-order hashes, ready for the Stratum coinbase Merkle path. */
  merkleBranch: readonly string[];
  /** The 32-byte hash following the BIP141 commitment header. */
  witnessCommitmentHash: string;
  payoutSnapshotId?: string;
  payoutOutputs?: ReadonlyArray<Readonly<IBlockTemplatePayoutOutput>>;
}

export interface PreparedMiningJobBodyReference {
  reference: string;
  checksum: string;
  checksumAlgorithm: typeof PREPARED_JOB_BODY_CHECKSUM_ALGORITHM;
  transactionCount: number;
  byteLength: number;
}

export interface PreparedMiningJob {
  tipKey: string;
  height: number;
  header: Readonly<PreparedMiningJobHeader>;
  coinbase: Readonly<PreparedMiningJobCoinbase>;
  body: Readonly<PreparedMiningJobBodyReference>;
  jobType: 'full' | 'empty';
  payoutMode: PayoutMode | 'all';
  forceCleanJobs: boolean;
}

export function createPreparedMiningJob(
  template: Readonly<IBlockTemplate>,
): PreparedMiningJob {
  validateTemplateNumbers(template);

  const previousBlockHash = parseHex(
    template.previousblockhash,
    'previousblockhash',
    HASH_BYTES,
  );
  const bits = parseHex(template.bits, 'bits', 4);
  const witnessCommitmentHash = parseWitnessCommitment(
    template.default_witness_commitment,
  );
  const body = prepareBodyReference(template.transactions);
  const merkleBranch = buildCoinbaseMerkleBranch(template.transactions);
  const normalizedPreviousBlockHash = previousBlockHash.toString('hex');

  return {
    tipKey: `${template.height}:${normalizedPreviousBlockHash}`,
    height: template.height,
    header: {
      previousBlockHash: normalizedPreviousBlockHash,
      previousBlockHashLE: Buffer.from(previousBlockHash)
        .reverse()
        .toString('hex'),
      version: template.version,
      bits: bits.readUInt32BE(0),
      bitsHex: bits.toString('hex'),
      minTime: template.mintime,
      currentTime: template.curtime,
    },
    coinbase: {
      valueSats: template.coinbasevalue,
      merkleBranch,
      witnessCommitmentHash,
      payoutSnapshotId: template.payoutSnapshotId,
      payoutOutputs: template.payoutOutputs?.map((output) => ({ ...output })),
    },
    body,
    jobType: template.jobType ?? 'full',
    payoutMode: template.payoutMode ?? 'all',
    forceCleanJobs: template.forceCleanJobs === true,
  };
}

function buildCoinbaseMerkleBranch(
  transactions: readonly IBlockTemplateTx[],
): string[] {
  let level: Buffer[] = [
    Buffer.alloc(HASH_BYTES),
    ...transactions.map((transaction, index) =>
      Buffer.from(
        parseHex(transaction.txid, `transactions[${index}].txid`, HASH_BYTES),
      ).reverse(),
    ),
  ];
  const branch: string[] = [];

  while (level.length > 1) {
    if (level.length % 2 !== 0) {
      level.push(Buffer.from(level[level.length - 1]));
    }

    branch.push(level[1].toString('hex'));
    const nextLevel: Buffer[] = [];
    for (let index = 0; index < level.length; index += 2) {
      nextLevel.push(hash256(Buffer.concat([level[index], level[index + 1]])));
    }
    level = nextLevel;
  }

  return branch;
}

function parseWitnessCommitment(commitment: string): string {
  const script = parseHex(commitment, 'default_witness_commitment');
  const minimumBytes = WITNESS_COMMITMENT_PREFIX.length / 2 + HASH_BYTES;
  if (script.length < minimumBytes) {
    throw new Error(
      `default_witness_commitment must be at least ${minimumBytes} bytes`,
    );
  }
  if (
    !script
      .subarray(0, WITNESS_COMMITMENT_PREFIX.length / 2)
      .equals(Buffer.from(WITNESS_COMMITMENT_PREFIX, 'hex'))
  ) {
    throw new Error('default_witness_commitment has an invalid BIP141 prefix');
  }

  return script
    .subarray(WITNESS_COMMITMENT_PREFIX.length / 2, minimumBytes)
    .toString('hex');
}

function prepareBodyReference(
  transactions: readonly IBlockTemplateTx[],
): PreparedMiningJobBodyReference {
  const checksum = crypto.createHash('sha256');
  let byteLength = 0;

  transactions.forEach((transaction, index) => {
    const txid = parseHex(
      transaction.txid,
      `transactions[${index}].txid`,
      HASH_BYTES,
    );
    if (
      typeof transaction.data !== 'string' ||
      transaction.data.length === 0 ||
      transaction.data.length % 2 !== 0
    ) {
      throw new Error(`transactions[${index}].data must not be empty`);
    }
    const transactionBytes = transaction.data.length / 2;
    if (transactionBytes > UINT32_MAX) {
      throw new Error(`transactions[${index}].data exceeds the checksum frame`);
    }
    checksum.update(txid);
    byteLength += transactionBytes;
  });

  const checksumHex = checksum.digest('hex');
  return {
    reference: `sha256:${checksumHex}`,
    checksum: checksumHex,
    checksumAlgorithm: PREPARED_JOB_BODY_CHECKSUM_ALGORITHM,
    transactionCount: transactions.length,
    byteLength,
  };
}

function parseHex(value: string, field: string, exactBytes?: number): Buffer {
  if (
    typeof value !== 'string' ||
    value.length % 2 !== 0 ||
    !/^[0-9a-f]*$/i.test(value)
  ) {
    throw new Error(`${field} must be valid hexadecimal`);
  }

  const bytes = Buffer.from(value, 'hex');
  if (exactBytes != null && bytes.length !== exactBytes) {
    throw new Error(`${field} must be exactly ${exactBytes} bytes`);
  }
  return bytes;
}

function validateTemplateNumbers(template: Readonly<IBlockTemplate>): void {
  if (
    !Number.isInteger(template.version) ||
    template.version < INT32_MIN ||
    template.version > INT32_MAX
  ) {
    throw new Error('version must be a signed 32-bit integer');
  }
  validateUnsignedInteger(template.height, 'height', Number.MAX_SAFE_INTEGER);
  validateUnsignedInteger(
    template.coinbasevalue,
    'coinbasevalue',
    Number.MAX_SAFE_INTEGER,
  );
  validateUnsignedInteger(template.mintime, 'mintime', UINT32_MAX);
  validateUnsignedInteger(template.curtime, 'curtime', UINT32_MAX);
}

function validateUnsignedInteger(
  value: number,
  field: string,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(
      `${field} must be an unsigned integer no greater than ${maximum}`,
    );
  }
}
