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

        const hexGroups = job.prevhash.match(/.{1,8}/g);
        // Reverse each group and concatenate them
        const reversedHexString = hexGroups
            ?.map(group => group.match(/.{2}/g)?.reverse()?.join(''))
            .join('');
        // Create the buffer from the reversed hex string
        const buffer = Buffer.from(reversedHexString, 'hex');
        buffer.copy(header, 4, 0, 32);

        // const hexGroups2 = job.merkleRoot.match(/.{1,8}/g);
        // // Reverse each group and concatenate them
        // const reversedHexString2 = hexGroups2
        //     ?.map(group => group.match(/.{2}/g)?.reverse()?.join(''))
        //     .join('');
        // // Create the buffer from the reversed hex string
        // const buffer2 = Buffer.from(reversedHexString2, 'hex');
        // buffer2.copy(header, 36, 0, 32);

        Buffer.from(job.merkleRoot, 'hex').copy(header, 36, 0, 32)

        header.writeInt32LE(job.ntime, 68);
        header.writeInt32LE(job.target, 72);
        header.writeInt32LE(nonce, 76);



        const hashBuffer: Buffer = crypto.createHash('sha256').update(header).digest();
        const hashResult: Buffer = crypto.createHash('sha256').update(hashBuffer).digest();


        s64 = this.le256todouble(hashResult);

        return parseInt(truediffone.div(s64).toString());


    }



    private le256todouble(target: Buffer): string {
        let number = BigInt(0);

        // Iterate over the buffer bytes in reverse order
        for (let i = target.length - 1; i >= 0; i--) {
            // Shift the number 8 bits to the left and OR with the current byte
            number = (number << BigInt(8)) | BigInt(target[i]);
        }

        return number.toString();

    }

    public incrementBitmask(rolledVersion: number, versionMask: number) {
        return (rolledVersion + 1) | versionMask;
    }
}