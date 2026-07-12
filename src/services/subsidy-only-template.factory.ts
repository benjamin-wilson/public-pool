import type {
  IBlockTemplate,
  IBlockTemplatePayoutOutput,
} from '../models/bitcoin-rpc/IBlockTemplate';
import type { PayoutMode } from '../types/payout-mode';
import { hash256 } from '../utils/hash.utils';

export type BitcoinNetworkName = 'mainnet' | 'testnet' | 'regtest';

export interface SubsidyOnlyPayoutSnapshot {
  id: string;
  payoutOutputs: IBlockTemplatePayoutOutput[];
}

export interface CreateSubsidyOnlyTemplateInput {
  authoritativeTemplate: Readonly<IBlockTemplate>;
  network: BitcoinNetworkName;
  payoutMode: PayoutMode;
  /** Overrides the network default, for custom chains and explicit test fixtures. */
  halvingInterval?: number;
  /** Required for PPLNS so the factory can never invent a miner-address fallback. */
  payoutSnapshot?: SubsidyOnlyPayoutSnapshot;
}

const SATOSHIS_PER_BITCOIN = 100_000_000n;
const INITIAL_BLOCK_SUBSIDY_SATS = 50n * SATOSHIS_PER_BITCOIN;
const MAX_SUBSIDY_HALVINGS = 64;

export const NETWORK_SUBSIDY_HALVING_INTERVALS: Readonly<
  Record<BitcoinNetworkName, number>
> = {
  mainnet: 210_000,
  testnet: 210_000,
  regtest: 150,
};

export const EMPTY_WITNESS_COMMITMENT_HASH = hash256(Buffer.alloc(64)).toString(
  'hex',
);
export const EMPTY_DEFAULT_WITNESS_COMMITMENT = `6a24aa21a9ed${EMPTY_WITNESS_COMMITMENT_HASH}`;

export function calculateBlockSubsidySats(
  candidateHeight: number,
  network: BitcoinNetworkName,
  halvingInterval = NETWORK_SUBSIDY_HALVING_INTERVALS[network],
): number {
  if (!Number.isSafeInteger(candidateHeight) || candidateHeight < 0) {
    throw new Error('Candidate height must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(halvingInterval) || halvingInterval <= 0) {
    throw new Error('Subsidy halving interval must be a positive safe integer');
  }

  const halvings = Math.floor(candidateHeight / halvingInterval);
  if (halvings >= MAX_SUBSIDY_HALVINGS) {
    return 0;
  }

  return Number(INITIAL_BLOCK_SUBSIDY_SATS >> BigInt(halvings));
}

export function createSubsidyOnlyBlockTemplate(
  input: CreateSubsidyOnlyTemplateInput,
): IBlockTemplate {
  const {
    authoritativeTemplate,
    network,
    payoutMode,
    halvingInterval,
    payoutSnapshot,
  } = input;
  const subsidySats = calculateBlockSubsidySats(
    authoritativeTemplate.height,
    network,
    halvingInterval,
  );

  const payout = resolvePayout(payoutMode, payoutSnapshot, subsidySats);
  const authoritativeFields = { ...authoritativeTemplate };
  delete authoritativeFields.payoutSnapshotId;
  delete authoritativeFields.payoutOutputs;

  return {
    ...authoritativeFields,
    rules: [...authoritativeTemplate.rules],
    vbavailable: { ...authoritativeTemplate.vbavailable },
    coinbaseaux: { ...authoritativeTemplate.coinbaseaux },
    mutable: [...authoritativeTemplate.mutable],
    capabilities: [...authoritativeTemplate.capabilities],
    transactions: [],
    coinbasevalue: subsidySats,
    default_witness_commitment: EMPTY_DEFAULT_WITNESS_COMMITMENT,
    forceCleanJobs: true,
    jobType: 'empty',
    payoutMode,
    ...payout,
  };
}

function resolvePayout(
  payoutMode: PayoutMode,
  payoutSnapshot: SubsidyOnlyPayoutSnapshot | undefined,
  subsidySats: number,
): Pick<IBlockTemplate, 'payoutSnapshotId' | 'payoutOutputs'> {
  if (payoutMode === 'solo') {
    return {
      payoutSnapshotId: undefined,
      payoutOutputs: undefined,
    };
  }

  if (payoutSnapshot == null || payoutSnapshot.id.trim().length === 0) {
    throw new Error(
      'PPLNS subsidy-only templates require an explicit payout snapshot',
    );
  }
  if (payoutSnapshot.payoutOutputs.length === 0) {
    throw new Error('PPLNS subsidy-only templates require payout outputs');
  }

  let allocatedSats = 0;
  const payoutOutputs = payoutSnapshot.payoutOutputs.map((output) => {
    if (output.address.trim().length === 0) {
      throw new Error('PPLNS payout output address must not be empty');
    }
    if (!Number.isSafeInteger(output.amountSats) || output.amountSats < 0) {
      throw new Error(
        'PPLNS subsidy-only payout outputs require non-negative integer amountSats',
      );
    }
    allocatedSats += output.amountSats;
    return {
      address: output.address,
      amountSats: output.amountSats,
    };
  });

  if (allocatedSats !== subsidySats) {
    throw new Error('PPLNS payout outputs must allocate the entire block subsidy');
  }

  return {
    payoutSnapshotId: payoutSnapshot.id,
    payoutOutputs,
  };
}
