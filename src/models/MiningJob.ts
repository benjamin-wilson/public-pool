import { AddressType, getAddressInfo } from 'bitcoin-address-validation';
import * as bitcoinjs from 'bitcoinjs-lib';

import { IJobTemplate } from '../services/stratum-v1-jobs.service';
import { eResponseMethod } from './enums/eResponseMethod';
import { IMiningNotify } from './stratum-messages/IMiningNotify';

interface AddressObject {
  address: string;
  percent: number;
}
export class MiningJob {
  private coinbaseTransaction: bitcoinjs.Transaction;
  private coinbasePart1: string;
  private coinbasePart2: string;

  public jobTemplateId: string;
  public networkDifficulty: number;

  constructor(
    private network: bitcoinjs.networks.Network,
    public jobId: string,
    payoutInformation: AddressObject[],
    jobTemplate: IJobTemplate,
  ) {
    this.jobTemplateId = jobTemplate.blockData.id;

    this.coinbaseTransaction = this.createCoinbaseTransaction(
      payoutInformation,
      jobTemplate.blockData.coinbasevalue,
    );

    //The commitment is recorded in a scriptPubKey of the coinbase transaction. It must be at least 38 bytes, with the first 6-byte of 0x6a24aa21a9ed, that is:
    //     1-byte - OP_RETURN (0x6a)
    //     1-byte - Push the following 36 bytes (0x24)
    //     4-byte - Commitment header (0xaa21a9ed)
    const segwitMagicBits = Buffer.from('aa21a9ed', 'hex');
    //    32-byte - Commitment hash: Double-SHA256(witness root hash|witness reserved value)

    //    39th byte onwards: Optional data with no consensus meaning
    const extra = Buffer.from('Public-Pool');

    // Encode the block height
    // https://github.com/bitcoin/bips/blob/master/bip-0034.mediawiki
    const blockHeightEncoded = bitcoinjs.script.number.encode(
      jobTemplate.blockData.height,
    );

    // Get the length of the block height encoding
    const blockHeightLengthByte = Buffer.from([blockHeightEncoded.length]);

    // generate padding and take length of encode blockHeight into account
    const padding = Buffer.alloc(8 + (3 - blockHeightEncoded.length), 0);

    // build the script
    this.coinbaseTransaction.ins[0].script = Buffer.concat([
      blockHeightLengthByte,
      blockHeightEncoded,
      extra,
      padding,
    ]);

    this.coinbaseTransaction.addOutput(
      bitcoinjs.script.compile([
        bitcoinjs.opcodes.OP_RETURN,
        Buffer.concat([segwitMagicBits, jobTemplate.block.witnessCommit]),
      ]),
      0,
    );

    // get the non-witness coinbase tx
    //@ts-ignore
    const serializedCoinbaseTx = this.coinbaseTransaction
      .__toBuffer()
      .toString('hex');

    const inputScript = this.coinbaseTransaction.ins[0].script.toString('hex');

    const partOneIndex =
      serializedCoinbaseTx.indexOf(inputScript) + inputScript.length;

    this.coinbasePart1 = serializedCoinbaseTx.slice(0, partOneIndex - 16);
    this.coinbasePart2 = serializedCoinbaseTx.slice(partOneIndex);
  }

  public copyAndUpdateBlock(
    jobTemplate: IJobTemplate,
    versionMask: number,
    nonce: number,
    extraNonce: string,
    extraNonce2: string,
    timestamp: number,
  ): bitcoinjs.Block {
    const testBlock = Object.assign(new bitcoinjs.Block(), jobTemplate.block);
    testBlock.transactions = jobTemplate.block.transactions.map((tx) => {
      return Object.assign(new bitcoinjs.Transaction(), tx);
    });

    testBlock.transactions[0] = this.coinbaseTransaction;

    testBlock.nonce = nonce;

    // recompute version mask
    if (versionMask !== undefined && versionMask != 0) {
      testBlock.version = testBlock.version ^ versionMask;
    }

    // set the nonces
    const nonceScript = testBlock.transactions[0].ins[0].script.toString('hex');

    testBlock.transactions[0].ins[0].script = Buffer.from(
      `${nonceScript.substring(
        0,
        nonceScript.length - 16,
      )}${extraNonce}${extraNonce2}`,
      'hex',
    );

    //recompute the root since we updated the coinbase script with the nonces
    testBlock.merkleRoot = this.calculateMerkleRootHash(
      testBlock.transactions[0].getHash(false),
      jobTemplate.merkle_branch,
    );

    testBlock.timestamp = timestamp;

    return testBlock;
  }

  private calculateMerkleRootHash(
    newRoot: Buffer,
    merkleBranches: string[],
  ): Buffer {
    const bothMerkles = Buffer.alloc(64);

    bothMerkles.set(newRoot);

    for (let i = 0; i < merkleBranches.length; i++) {
      bothMerkles.set(Buffer.from(merkleBranches[i], 'hex'), 32);
      newRoot = bitcoinjs.crypto.hash256(bothMerkles);
      bothMerkles.set(newRoot);
    }

    return bothMerkles.subarray(0, 32);
  }

  private createCoinbaseTransaction(
    addresses: AddressObject[],
    reward: number,
  ): bitcoinjs.Transaction {
    // Part 1
    const coinbaseTransaction = new bitcoinjs.Transaction();

    // Set the version of the transaction
    coinbaseTransaction.version = 2;

    // Add the coinbase input (input with no previous output)
    coinbaseTransaction.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);

    // Add an output
    let rewardBalance = reward;

    addresses.forEach((recipientAddress) => {
      const amount = Math.floor((recipientAddress.percent / 100) * reward);
      rewardBalance -= amount;
      coinbaseTransaction.addOutput(
        this.getPaymentScript(recipientAddress.address),
        amount,
      );
    });

    //Add any remaining sats from the Math.floor
    coinbaseTransaction.outs[0].value += rewardBalance;

    const segwitWitnessReservedValue = Buffer.alloc(32, 0);

    //and the coinbase's input's witness must consist of a single 32-byte array for the witness reserved value
    coinbaseTransaction.ins[0].witness = [segwitWitnessReservedValue];

    return coinbaseTransaction;
  }

  private getPaymentScript(address: string): Buffer {
    const addressInfo = getAddressInfo(address);
    switch (addressInfo.type) {
      case AddressType.p2wpkh: {
        return bitcoinjs.payments.p2wpkh({ address, network: this.network })
          .output;
      }
      case AddressType.p2pkh: {
        return bitcoinjs.payments.p2pkh({ address, network: this.network })
          .output;
      }
      case AddressType.p2sh: {
        return bitcoinjs.payments.p2sh({ address, network: this.network })
          .output;
      }
      case AddressType.p2tr: {
        return bitcoinjs.payments.p2tr({ address, network: this.network })
          .output;
      }
      case AddressType.p2wsh: {
        return bitcoinjs.payments.p2wsh({ address, network: this.network })
          .output;
      }
      default: {
        return Buffer.alloc(0);
      }
    }
  }

  public response(jobTemplate: IJobTemplate): string {
    const job: IMiningNotify = {
      id: null,
      method: eResponseMethod.MINING_NOTIFY,
      params: [
        this.jobId,
        this.swapEndianWords(jobTemplate.block.prevHash).toString('hex'),
        this.coinbasePart1,
        this.coinbasePart2,
        jobTemplate.merkle_branch,
        jobTemplate.block.version.toString(16),
        jobTemplate.block.bits.toString(16),
        jobTemplate.block.timestamp.toString(16),
        jobTemplate.blockData.clearJobs,
      ],
    };

    return JSON.stringify(job) + '\n';
  }

  private swapEndianWords(buffer: Buffer): Buffer {
    const swappedBuffer = Buffer.alloc(buffer.length);

    for (let i = 0; i < buffer.length; i += 4) {
      swappedBuffer[i] = buffer[i + 3];
      swappedBuffer[i + 1] = buffer[i + 2];
      swappedBuffer[i + 2] = buffer[i + 1];
      swappedBuffer[i + 3] = buffer[i];
    }

    return swappedBuffer;
  }
}
