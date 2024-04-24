import { Injectable } from '@nestjs/common';
import * as bitcoinjs from 'bitcoinjs-lib';
import * as merkle from 'merkle-lib';
import * as merkleProof from 'merkle-lib/proof';
import {
  combineLatest,
  delay,
  filter,
  from,
  interval,
  map,
  Observable,
  shareReplay,
  startWith,
  switchMap,
  tap,
} from 'rxjs';

import { MiningJob } from '../models/MiningJob';
import { BitcoinRpcService } from './bitcoin-rpc.service';

export interface IJobTemplate {
  block: bitcoinjs.Block;
  merkle_branch: string[];
  blockData: {
    id: string;
    coinbasevalue: number;
    networkDifficulty: number;
    height: number;
    clearJobs: boolean;
  };
}

@Injectable()
export class StratumV1JobsService {
  private lastIntervalCount: number;
  private skipNext = false;
  public newMiningJob$: Observable<IJobTemplate>;

  public latestJobId = 1;
  public latestJobTemplateId = 1;

  public jobs: { [jobId: string]: MiningJob } = {};

  public blocks: { [id: number]: IJobTemplate } = {};

  // offset the interval so that all the cluster processes don't try and refresh at the same time.
  private delay =
    process.env.NODE_APP_INSTANCE == null
      ? 0
      : parseInt(process.env.NODE_APP_INSTANCE) * 5000;

  constructor(private readonly bitcoinRpcService: BitcoinRpcService) {
    this.newMiningJob$ = combineLatest([
      this.bitcoinRpcService.newBlock$,
      interval(60000).pipe(delay(this.delay), startWith(-1)),
    ]).pipe(
      switchMap(([miningInfo, interval]) => {
        return from(
          this.bitcoinRpcService.getBlockTemplate(miningInfo.blocks),
        ).pipe(
          map((blockTemplate) => {
            return {
              blockTemplate,
              interval,
            };
          }),
        );
      }),
      map(({ blockTemplate, interval }) => {
        let clearJobs = false;
        if (this.lastIntervalCount === interval) {
          clearJobs = true;
          this.skipNext = true;
          console.log('new block');
        }

        if (this.skipNext == true && clearJobs == false) {
          this.skipNext = false;
          return null;
        }

        this.lastIntervalCount = interval;

        return {
          version: blockTemplate.version,
          bits: parseInt(blockTemplate.bits, 16),
          prevHash: this.convertToLittleEndian(blockTemplate.previousblockhash),
          transactions: blockTemplate.transactions.map((t) =>
            bitcoinjs.Transaction.fromHex(t.data),
          ),
          coinbasevalue: blockTemplate.coinbasevalue,
          timestamp: Math.floor(new Date().getTime() / 1000),
          networkDifficulty: this.calculateNetworkDifficulty(
            parseInt(blockTemplate.bits, 16),
          ),
          clearJobs,
          height: blockTemplate.height,
        };
      }),
      filter((next) => next != null),
      map(
        ({
          version,
          bits,
          prevHash,
          transactions,
          timestamp,
          coinbasevalue,
          networkDifficulty,
          clearJobs,
          height,
        }) => {
          const block = new bitcoinjs.Block();

          //create an empty coinbase tx
          const tempCoinbaseTx = new bitcoinjs.Transaction();
          tempCoinbaseTx.version = 2;
          tempCoinbaseTx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
          tempCoinbaseTx.ins[0].witness = [Buffer.alloc(32, 0)];
          transactions.unshift(tempCoinbaseTx);

          const transactionBuffers = transactions.map((tx) =>
            tx.getHash(false),
          );

          const merkleTree = merkle(
            transactionBuffers,
            bitcoinjs.crypto.hash256,
          );
          const merkleBranches: Buffer[] = merkleProof(
            merkleTree,
            transactionBuffers[0],
          ).filter((h) => h != null);
          block.merkleRoot = merkleBranches.pop();

          // remove the first (coinbase) and last (root) element from the branch
          const merkle_branch = merkleBranches
            .slice(1, merkleBranches.length)
            .map((b) => b.toString('hex'));

          block.prevHash = prevHash;
          block.version = version;
          block.bits = bits;
          block.timestamp = timestamp;

          block.transactions = transactions;
          block.witnessCommit = bitcoinjs.Block.calculateMerkleRoot(
            transactions,
            true,
          );

          const id = this.getNextTemplateId();
          this.latestJobTemplateId++;
          return {
            block,
            merkle_branch,
            blockData: {
              id,
              coinbasevalue,
              networkDifficulty,
              height,
              clearJobs,
            },
          };
        },
      ),
      tap((data) => {
        if (data.blockData.clearJobs) {
          this.blocks = {};
          this.jobs = {};
        }
        this.blocks[data.blockData.id] = data;
      }),
      shareReplay({ refCount: true, bufferSize: 1 }),
    );
  }

  private calculateNetworkDifficulty(nBits: number) {
    const mantissa: number = nBits & 0x007fffff; // Extract the mantissa from nBits
    const exponent: number = (nBits >> 24) & 0xff; // Extract the exponent from nBits

    const target: number = mantissa * Math.pow(256, exponent - 3); // Calculate the target value

    const difficulty: number = (Math.pow(2, 208) * 65535) / target; // Calculate the difficulty

    return difficulty;
  }

  private convertToLittleEndian(hash: string): Buffer {
    const bytes = Buffer.from(hash, 'hex');
    Array.prototype.reverse.call(bytes);
    return bytes;
  }

  public getJobTemplateById(jobTemplateId: string): IJobTemplate | null {
    return this.blocks[jobTemplateId];
  }

  public addJob(job: MiningJob) {
    this.jobs[job.jobId] = job;
    this.latestJobId++;
  }

  public getJobById(jobId: string) {
    return this.jobs[jobId];
  }

  public getNextTemplateId() {
    return this.latestJobTemplateId.toString(16);
  }
  public getNextId() {
    return this.latestJobId.toString(16);
  }
}
