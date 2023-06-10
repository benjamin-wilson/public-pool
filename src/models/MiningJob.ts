import * as crypto from 'crypto';

import { eResponseMethod } from './enums/eResponseMethod';

export class MiningJob {
    public id: number;
    public method: eResponseMethod.MINING_NOTIFY;
    public params: string[];


    public job_id: string; // ID of the job. Use this ID while submitting share generated from this job.
    public prevhash: string; // Hash of previous block.
    public coinb1: string; // Initial part of coinbase transaction.
    public coinb2: string; // Final part of coinbase transaction.
    public merkle_branch: string[]; // List of hashes, will be used for calculation of merkle root. This is not a list of all transactions, it only contains prepared hashes of steps of merkle tree algorithm.
    public version: string; // Bitcoin block version.
    public nbits: string; // Encoded current network difficulty
    public ntime: string; // Current ntime/
    public clean_jobs: boolean; // When true, server indicates that submitting shares from previous jobs don't have a sense and such shares will be rejected. When this flag is set, miner should also drop all previous jobs too.

    constructor() {

    }

    public response() {

        this.job_id = null;
        this.prevhash = null;
        this.coinb1 = null;
        this.coinb2 = null;
        this.merkle_branch = null;
        this.version = null;
        this.nbits = null;
        this.ntime = Math.floor(new Date().getTime() / 1000).toString();
        this.clean_jobs = false;



        return {
            id: this.id,
            method: this.method,
            params: [
                this.job_id,
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


    public buildCoinbaseHashBin(coinbase: string): Buffer {
        const sha256 = crypto.createHash('sha256');
        const sha256Digest = sha256.update(Buffer.from(coinbase, 'hex')).digest();

        const coinbaseHashSha256 = crypto.createHash('sha256');
        const coinbaseHash = coinbaseHashSha256.update(sha256Digest).digest();

        return coinbaseHash;
    }

    public buildMerkleRoot(merkleBranch: string[], coinbaseHashBin: Buffer): string {
        let merkleRoot = coinbaseHashBin;
        for (const h of merkleBranch) {
            const concatenatedBuffer = Buffer.concat([merkleRoot, Buffer.from(h, 'hex')]);
            merkleRoot = this.doubleSHA(concatenatedBuffer);
        }
        return merkleRoot.toString('hex');
    }

    private doubleSHA(data: Buffer): Buffer {
        const sha256 = crypto.createHash('sha256');
        const sha256Digest = sha256.update(data).digest();

        const doubleSha256 = crypto.createHash('sha256');
        const doubleSha256Digest = doubleSha256.update(sha256Digest).digest();

        return doubleSha256Digest;
    }


}