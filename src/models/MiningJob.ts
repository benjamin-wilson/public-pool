import * as crypto from 'crypto';

import { eResponseMethod } from './enums/eResponseMethod';
import { IBlockTempalte } from './IBlockTempalte';
import { randomUUID } from 'crypto';

export class MiningJob {
    public id: number;
    public method: eResponseMethod.MINING_NOTIFY;
    public params: string[];


    public job_id: string; // ID of the job. Use this ID while submitting share generated from this job.
    public prevhash: string; // The hex-encoded previous block hash.
    public coinb1: string; // The hex-encoded prefix of the coinbase transaction (to precede extra nonce 2).
    public coinb2: string; //The hex-encoded suffix of the coinbase transaction (to follow extra nonce 2).
    public merkle_branch: string[]; // List of hashes, will be used for calculation of merkle root. This is not a list of all transactions, it only contains prepared hashes of steps of merkle tree algorithm.
    public version: string; // The hex-encoded block version.
    public nbits: string; // The hex-encoded network difficulty required for the block.
    public ntime: string; // Current ntime/
    public clean_jobs: boolean; // When true, server indicates that submitting shares from previous jobs don't have a sense and such shares will be rejected. When this flag is set, miner should also drop all previous jobs too.

    constructor(blockTemplate: IBlockTempalte) {

        this.job_id = randomUUID();
        this.prevhash = blockTemplate.previousblockhash;

        this.version = blockTemplate.version.toString();
        this.nbits = blockTemplate.bits;
        this.ntime = Math.floor(new Date().getTime() / 1000).toString();
        this.clean_jobs = false;


        // Construct coinbase transaction
        const coinbaseTransaction = blockTemplate.transactions[0];
        const coinbaseHashBin = this.buildCoinbaseHashBin(coinbaseTransaction.data);
        this.coinb1 = this.coinbasePrefix(coinbaseTransaction.data, coinbaseHashBin);
        this.coinb2 = ''; // Assuming no suffix is required

        // Calculate merkle branch
        const merkleBranch = blockTemplate.transactions.slice(1).map((transaction) => transaction.hash);
        this.merkle_branch = this.buildMerkleBranch(merkleBranch, coinbaseHashBin);

    }



    public response() {

        return {
            id: 0,
            method: eResponseMethod.MINING_NOTIFY,
            params: [
                '123',///this.job_id,
                this.prevhash,
                this.coinb1,
                this.coinb2,
                this.merkle_branch,
                this.version,
                this.nbits,
                this.ntime,
                this.clean_jobs
            ]
        }

    }


    private coinbasePrefix(coinbase: string, coinbaseHashBin: Buffer): string {
        const coinbaseData = Buffer.from(coinbase, 'hex');
        const coinbaseSize = Buffer.alloc(1, coinbaseData.length);
        const extraNoncePlaceholder = Buffer.alloc(4); // Assuming 4 bytes for extra nonce
        const concatenatedBuffer = Buffer.concat([coinbaseSize, coinbaseData, extraNoncePlaceholder]);
        const merkleRoot = this.doubleSHA(Buffer.concat([coinbaseHashBin, concatenatedBuffer]));

        return merkleRoot.toString('hex');
    }


    private buildCoinbaseHashBin(coinbase: string): Buffer {
        const sha256 = crypto.createHash('sha256');
        const sha256Digest = sha256.update(Buffer.from(coinbase, 'hex')).digest();

        const coinbaseHashSha256 = crypto.createHash('sha256');
        const coinbaseHash = coinbaseHashSha256.update(sha256Digest).digest();

        return coinbaseHash;
    }

    private buildMerkleBranch(merkleBranch: string[], coinbaseHashBin: Buffer): string[] {
        const merkleRoots: string[] = [];
        let merkleRoot = coinbaseHashBin;

        for (const h of merkleBranch) {
            const concatenatedBuffer = Buffer.concat([merkleRoot, Buffer.from(h, 'hex')]);
            merkleRoot = this.doubleSHA(concatenatedBuffer);
            merkleRoots.push(merkleRoot.toString('hex'));
        }

        return merkleRoots.slice(0, 1);
    }

    // private buildMerkleRoot(merkleBranch: string[], coinbaseHashBin: Buffer): string {
    //     let merkleRoot = coinbaseHashBin;
    //     for (const h of merkleBranch) {
    //         const concatenatedBuffer = Buffer.concat([merkleRoot, Buffer.from(h, 'hex')]);
    //         merkleRoot = this.doubleSHA(concatenatedBuffer);
    //     }
    //     return merkleRoot.toString('hex');
    // }

    private doubleSHA(data: Buffer): Buffer {
        const sha256 = crypto.createHash('sha256');
        const sha256Digest = sha256.update(data).digest();

        const doubleSha256 = crypto.createHash('sha256');
        const doubleSha256Digest = doubleSha256.update(sha256Digest).digest();

        return doubleSha256Digest;
    }


}