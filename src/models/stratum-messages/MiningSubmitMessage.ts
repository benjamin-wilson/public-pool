import Big from 'big.js';
import { ArrayMaxSize, ArrayMinSize, IsArray } from 'class-validator';
import * as crypto from 'crypto';

import { eRequestMethod } from '../enums/eRequestMethod';
import { MiningJob } from '../MiningJob';
import { StratumBaseMessage } from './StratumBaseMessage';

export class MiningSubmitMessage extends StratumBaseMessage {

    @IsArray()
    @ArrayMinSize(5)
    @ArrayMaxSize(5)
    public params: string[];

    public userId: string;
    public jobId: string;
    public extraNonce2: string;
    public ntime: string;
    public nonce: string

    constructor() {
        super();
        this.method = eRequestMethod.AUTHORIZE;
    }


    public parse() {
        this.userId = this.params[0];
        this.jobId = this.params[1];
        this.extraNonce2 = this.params[2];
        this.ntime = this.params[3];
        this.nonce = this.params[4];
    }

    public response() {
        return {
            id: null,
            error: null,
            result: true
        };
    }


    testNonceValue(job: MiningJob, nonce: number, midstateIndex: number = 0): number {
        const truediffone = Big('26959535291011309493156476344723991336010898738574164086137773096960');
        let s64: string;
        const header = Buffer.alloc(80);

        // TODO: Use the midstate hash instead of hashing the whole header

        // Copy data from job to header

        let rolledVersion = job.version;
        for (let i = 0; i < midstateIndex; i++) {
            rolledVersion = this.incrementBitmask(rolledVersion, job.versionMask);
        }



        header.writeInt32LE(rolledVersion, 0);
        header.write(this.convertStringToLE(job.prevhash), 4, 'hex')
        Buffer.from(job.merkleRoot, 'hex').copy(header, 36, 0, 32)
        header.writeInt32LE(job.ntime, 68);
        header.writeInt32LE(job.target, 72);
        header.writeInt32LE(nonce, 76);


        const hashBuffer: Buffer = crypto.createHash('sha256').update(header).digest();
        const hashResult: Buffer = crypto.createHash('sha256').update(hashBuffer).digest();


        s64 = this.le256todouble(hashResult);

        return parseInt(truediffone.div(s64).toString());


    }

    private convertStringToLE(str: string) {
        const hexGroups = str.match(/.{1,8}/g);
        // Reverse each group and concatenate them
        const reversedHexString = hexGroups.reduce((pre, cur, indx, arr) => {
            const reversed = cur.match(/.{2}/g).reverse();
            return `${pre}${reversed.join('')}`;
        }, '');
        return reversedHexString;
    }


    private le256todouble(target: Buffer): string {

        const number = target.reduceRight((acc, byte) => {
            // Shift the number 8 bits to the left and OR with the current byte
            return (acc << BigInt(8)) | BigInt(byte);
        }, BigInt(0));

        return number.toString();

    }

    public incrementBitmask(rolledVersion: number, versionMask: number) {
        return (rolledVersion + 1) | versionMask;
    }
}