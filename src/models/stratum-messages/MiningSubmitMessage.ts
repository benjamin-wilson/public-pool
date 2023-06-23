import Big from 'big.js';
import { Expose, Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString } from 'class-validator';
import * as crypto from 'crypto';

import { eRequestMethod } from '../enums/eRequestMethod';
import { MiningJob } from '../MiningJob';
import { StratumBaseMessage } from './StratumBaseMessage';

export class MiningSubmitMessage extends StratumBaseMessage {

    @IsArray()
    @ArrayMinSize(5)
    @ArrayMaxSize(6)
    public params: string[];

    @Expose()
    @IsString()
    @Transform(({ value, key, obj, type }) => {
        return obj.params[0];
    })
    public userId: string;
    @Expose()
    @IsString()
    @Transform(({ value, key, obj, type }) => {
        return obj.params[1];
    })
    public jobId: string;
    @Expose()
    @IsString()
    @Transform(({ value, key, obj, type }) => {
        return obj.params[2];
    })
    public extraNonce2: string;
    @Expose()
    @IsString()
    @Transform(({ value, key, obj, type }) => {
        return obj.params[3];
    })
    public ntime: string;
    @Expose()
    @IsString()
    @Transform(({ value, key, obj, type }) => {
        return obj.params[4];
    })
    public nonce: string
    @Expose()
    @IsString()
    @Transform(({ value, key, obj, type }) => {
        return obj.params[5];
    })
    public versionMask: string;
    constructor() {
        super();
        this.method = eRequestMethod.AUTHORIZE;
    }


    public response() {
        return {
            id: null,
            error: null,
            result: true
        };
    }


    public calculateDifficulty(clientId: string, job: MiningJob, submission: MiningSubmitMessage): number {

        const nonce = parseInt(submission.nonce, 16);
        const versionMask = parseInt(submission.versionMask, 16);
        const extraNonce = clientId;
        const extraNonce2 = submission.extraNonce2;

        const coinbaseTx = `${job.coinb1}${extraNonce}${extraNonce2}${job.coinb2}`;


        const newRoot = this.calculateMerkleRootHash(coinbaseTx, job.merkle_branch)

        const truediffone = Big('26959535291011309493156476344723991336010898738574164086137773096960');

        const header = Buffer.alloc(80);

        let version = job.version;
        if (versionMask !== undefined && versionMask != 0) {
            version = (version ^ versionMask);
        }


        header.writeUInt32LE(version, 0);

        header.write(this.swapEndianWords(job.prevhash), 4, 'hex')
        newRoot.copy(header, 36, 0, 32)
        header.writeUInt32LE(job.ntime, 68);
        header.writeBigUint64LE(BigInt(job.nbits), 72);
        header.writeUInt32LE(nonce, 76);

        console.log(header.toString('hex'))


        const hashBuffer: Buffer = crypto.createHash('sha256').update(header).digest();
        const hashResult: Buffer = crypto.createHash('sha256').update(hashBuffer).digest();


        let s64 = this.le256todouble(hashResult);

        return truediffone.div(s64.toString()).toNumber();


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


    private le256todouble(target: Buffer): bigint {

        const number = target.reduceRight((acc, byte) => {
            // Shift the number 8 bits to the left and OR with the current byte
            return (acc << BigInt(8)) | BigInt(byte);
        }, BigInt(0));

        return number;
    }

    private calculateMerkleRootHash(coinbaseTx: string, merkleBranches: string[]): Buffer {

        let coinbaseTxBuf = Buffer.from(coinbaseTx, 'hex');

        const bothMerkles = Buffer.alloc(64);
        let test = this.sha256(coinbaseTxBuf)
        let newRoot = this.sha256(test);
        bothMerkles.set(newRoot);

        for (let i = 0; i < merkleBranches.length; i++) {
            bothMerkles.set(Buffer.from(merkleBranches[i], 'hex'), 32);
            newRoot = this.sha256(this.sha256(bothMerkles));
            bothMerkles.set(newRoot);
        }

        return bothMerkles.subarray(0, 32)
    }

    private sha256(data: Buffer) {
        return crypto.createHash('sha256').update(data).digest()
    }

}