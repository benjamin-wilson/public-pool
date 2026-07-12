import axios from 'axios';
import * as bitcoinjs from 'bitcoinjs-lib';
import { BehaviorSubject, firstValueFrom } from 'rxjs';

import { MiningJob } from '../src/models/MiningJob';
import { IBlockTemplate } from '../src/models/bitcoin-rpc/IBlockTemplate';
import { createSubsidyOnlyBlockTemplate } from '../src/services/subsidy-only-template.factory';
import { StratumV1JobsService } from '../src/services/stratum-v1-jobs.service';

const describeRegtest = process.env.RUN_BITCOIN_REGTEST_INTEGRATION === 'true'
  ? describe
  : describe.skip;

describeRegtest('Bitcoin Core regtest block proposals', () => {
  const rpcUrl = process.env.BITCOIN_REGTEST_RPC_URL ?? 'http://127.0.0.1:28332';
  const rpcUser = process.env.BITCOIN_REGTEST_RPC_USER ?? 'bitcoin';
  const rpcPassword = process.env.BITCOIN_REGTEST_RPC_PASSWORD ?? 'bitcoin';
  let rpcId = 0;

  it('accepts reconstructed subsidy-only and full jobs in proposal mode', async () => {
    const authoritative = await rpc<IBlockTemplate>('getblocktemplate', [{
      mode: 'template',
      rules: ['segwit'],
      capabilities: ['proposal'],
    }]);
    const empty = createSubsidyOnlyBlockTemplate({
      authoritativeTemplate: authoritative,
      network: 'regtest',
      payoutMode: 'solo',
    });

    const emptyBlock = await reconstruct(empty);
    const fullBlock = await reconstruct({
      ...authoritative,
      payoutMode: 'solo',
      jobType: 'full',
      forceCleanJobs: true,
    });

    expect(emptyBlock.transactions).toHaveLength(1);
    expect(fullBlock.transactions).toHaveLength(authoritative.transactions.length + 1);
    await expect(propose(emptyBlock)).resolves.toBeNull();
    await expect(propose(fullBlock)).resolves.toBeNull();
  });

  async function reconstruct(template: IBlockTemplate): Promise<bitcoinjs.Block> {
    const source = new BehaviorSubject(template);
    const jobs = new StratumV1JobsService({
      newBlockTemplate$: source.asObservable(),
      miningInfo: { blocks: template.height - 1 },
    } as any);
    const jobTemplate = await firstValueFrom(jobs.newMiningJob$);
    const payoutAddress = bitcoinjs.payments.p2wpkh({
      hash: Buffer.alloc(20, 1),
      network: bitcoinjs.networks.regtest,
    }).address!;
    const job = new MiningJob(
      bitcoinjs.networks.regtest,
      '1',
      [{ address: payoutAddress, percent: 100 }],
      jobTemplate,
    );
    return job.copyAndUpdateBlock(
      jobTemplate,
      0,
      0,
      '01020304',
      '05060708090a0b0c',
      Math.max(template.mintime, template.curtime, Math.floor(Date.now() / 1000)),
    );
  }

  async function propose(block: bitcoinjs.Block): Promise<string | null> {
    return rpc<string | null>('getblocktemplate', [{
      mode: 'proposal',
      data: block.toHex(false),
      rules: ['segwit'],
    }]);
  }

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await axios.post(rpcUrl, {
      jsonrpc: '1.0',
      id: ++rpcId,
      method,
      params,
    }, {
      auth: { username: rpcUser, password: rpcPassword },
      timeout: 30_000,
    });
    if (response.data.error != null) {
      throw new Error(response.data.error.message ?? JSON.stringify(response.data.error));
    }
    return response.data.result as T;
  }
});
