import Big from 'big.js';
import { Block } from 'bitcoinjs-lib';
import * as bitcoinjs from 'bitcoinjs-lib';
import { plainToInstance } from 'class-transformer';
import { validate, ValidatorOptions } from 'class-validator';
import { Socket } from 'net';

import { eRequestMethod } from './enums/eRequestMethod';
import { eResponseMethod } from './enums/eResponseMethod';
import { IMiningNotify } from './stratum-messages/IMiningNotify';
import { MiningSubmitMessage } from './stratum-messages/MiningSubmitMessage';

export class ProxyClient {
  public braiinsSocket: Socket;
  public serverDifficulty: number;
  public jobs: { [jobId: string]: IMiningNotify } = {};
  private extraNonce: string;

  constructor(public socket: Socket) {
    this.braiinsSocket = new Socket();
    this.braiinsSocket.connect(3333, 'us-east.stratum.braiins.com', () => {
      console.log('Connected to braiins');
    });

    this.braiinsSocket.on('data', (data) => {
      data
        .toString()
        .split('\n')
        .filter((m) => m.length > 0)
        .forEach(async (m) => {
          try {
            await this.toClient(m);
          } catch (e) {
            await socket.end();
            console.error(e);
          }
        });
    });

    this.braiinsSocket.on('close', () => {
      console.log('Braiins closed connection');
      socket.end();
    });

    socket.on('error', async (error: Error) => {});

    socket.on('data', (data: Buffer) => {
      data
        .toString()
        .split('\n')
        .filter((m) => m.length > 0)
        .forEach(async (m) => {
          try {
            await this.toServer(m);
          } catch (e) {
            await socket.end();
            console.error(e);
          }
        });
    });
    socket.on('close', () => {
      console.log('Client closed connection');
      this.braiinsSocket.end();
    });
  }

  private async toClient(message: string) {
    let parsedMessage: IMiningNotify | any;
    try {
      parsedMessage = JSON.parse(message);
    } catch (e) {
      //console.log("Invalid JSON");
      await this.socket.end();
      return;
    }

    if (parsedMessage.method == null && Array.isArray(parsedMessage.result)) {
      this.extraNonce = parsedMessage.result[1];
    }

    switch (parsedMessage.method) {
      case eResponseMethod.SET_DIFFICULTY: {
        this.serverDifficulty = parsedMessage.params[0];
        parsedMessage.params[0] = 512;
        message = JSON.stringify(parsedMessage);
        break;
      }
      case eResponseMethod.MINING_NOTIFY: {
        // clear jobs
        if ((parsedMessage as IMiningNotify).params[8]) {
          this.jobs = {};
        }
        this.jobs[parsedMessage.params[0]] = parsedMessage;
        break;
      }
    }
    console.log('Server:');
    console.log(message);
    this.socket.write(message + `\n`);
  }
  private async toServer(message: string) {
    let parsedMessage = null;
    try {
      parsedMessage = JSON.parse(message);
    } catch (e) {
      //console.log("Invalid JSON");
      await this.socket.end();
      return;
    }

    switch (parsedMessage.method) {
      case eRequestMethod.AUTHORIZE: {
        parsedMessage.params[0] = 'battlechicken';
        message = JSON.stringify(parsedMessage);
        break;
      }
      case eRequestMethod.SUBMIT: {
        parsedMessage.params[0] = 'battlechicken';

        message = JSON.stringify(parsedMessage);

        const miningSubmitMessage = plainToInstance(
          MiningSubmitMessage,
          parsedMessage,
        );

        const validatorOptions: ValidatorOptions = {
          whitelist: true,
          forbidNonWhitelisted: true,
        };

        const errors = await validate(miningSubmitMessage, validatorOptions);

        if (errors.length === 0) {
          this.checkSubmission(miningSubmitMessage);
        } else {
          console.log('parsing error');
        }
        break;
      }
    }
    console.log('Client:');
    console.log(message);
    this.braiinsSocket.write(message + '\n');
  }

  private checkSubmission(submission: MiningSubmitMessage) {
    console.log('Submission:');
    console.log(submission);

    const job = this.jobs[submission.jobId];
    if (job == null) {
      console.log('Job not found');
      return;
    }

    const versionMask = parseInt(submission.versionMask, 16);

    const block = new Block();

    block.version = parseInt(job.params[5], 16);
    if (submission.versionMask !== undefined && versionMask != 0) {
      block.version = block.version ^ versionMask;
    }

    const prevHash = this.swapEndianWords(job.params[1]);
    block.prevHash = Buffer.from(prevHash, 'hex');
    const coinbase = Buffer.from(
      `${job.params[2]}${this.extraNonce}${submission.extraNonce2}${job.params[3]}`,
      'hex',
    );
    const coinbaseHash = bitcoinjs.crypto.hash256(coinbase);
    block.merkleRoot = this.calculateMerkleRootHash(
      coinbaseHash,
      job.params[4],
    );
    block.timestamp = parseInt(submission.ntime, 16);
    block.bits = parseInt(job.params[6], 16);
    block.nonce = parseInt(submission.nonce, 16);

    const header = block.toBuffer(true);

    const diff = this.calculateDifficulty(header);

    console.log(`DIFFICULTY: ${diff.submissionDifficulty}`);
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

  private calculateDifficulty(header: Buffer): {
    submissionDifficulty: number;
    submissionHash: string;
  } {
    const hashResult = bitcoinjs.crypto.hash256(header);

    const s64 = this.le256todouble(hashResult);

    const truediffone = Big(
      '26959535291011309493156476344723991336010898738574164086137773096960',
    );
    const difficulty = truediffone.div(s64.toString());
    return {
      submissionDifficulty: difficulty.toNumber(),
      submissionHash: hashResult.toString('hex'),
    };
  }

  private le256todouble(target: Buffer): bigint {
    const number = target.reduceRight((acc, byte) => {
      // Shift the number 8 bits to the left and OR with the current byte
      return (acc << BigInt(8)) | BigInt(byte);
    }, BigInt(0));

    return number;
  }

  private swapEndianWords(str: string) {
    const hexGroups = str.match(/.{1,8}/g);
    // Reverse each group and concatenate them
    const reversedHexString = hexGroups.reduce((pre, cur, indx, arr) => {
      const reversed = cur.match(/.{2}/g).reverse();
      return `${pre}${reversed.join('')}`;
    }, '');
    return reversedHexString;
  }
}
