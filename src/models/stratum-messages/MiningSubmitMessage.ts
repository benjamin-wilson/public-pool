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


    testNonceValue(job: MiningJob, nonce: number, midstateIndex: number = 0): string {
        const truediffone = Big('26959535291011309493156476344723991336010898738574164086137773096960');
        let s64: Big, ds: number;
        const header = Buffer.alloc(80);

        // TODO: Use the midstate hash instead of hashing the whole header

        // Copy data from job to header

        let rolledVersion = job.version;
        for (let i = 0; i < midstateIndex; i++) {
            rolledVersion = this.incrementBitmask(rolledVersion, job.versionMask);
        }

        header.writeUInt32LE(rolledVersion, 0);
        Buffer.from(job.prevhash, 'hex').copy(header, 4);
        Buffer.from(job.merkleRoot, 'hex').copy(header, 36);
        header.writeUInt32LE(job.ntime, 68);
        header.writeUInt32LE(job.target, 72);
        header.writeUInt32LE(nonce, 76);

        console.log(header);

        const hashBuffer: Buffer = crypto.createHash('sha256').update(header).digest();
        const hashResult: Buffer = crypto.createHash('sha256').update(hashBuffer).digest();

        s64 = this.le256todouble(hashResult);
        ds = truediffone.div(s64);

        return ds.toString();
    }



    private le256todouble(target: Buffer): Big {

        const bits192 = new Big(6277101735386680763835789423207666416102355444464034512896);
        const bits128 = new Big(340282366920938463463374607431768211456);
        const bits64 = new Big(18446744073709551616);

        const data64_3 = target.readBigUInt64LE(24);
        const data64_2 = target.readBigUInt64LE(16);
        const data64_1 = target.readBigUInt64LE(8);
        const data64_0 = target.readBigUInt64LE(0);

        const dcut64 = new Big(data64_3).times(bits192)
            .plus(new Big(data64_2).times(bits128))
            .plus(new Big(data64_1).times(bits64))
            .plus(new Big(data64_0));

        return dcut64;
    }

    public incrementBitmask(rolledVersion: number, versionMask: number) {
        return (rolledVersion + 1) | versionMask;
    }
}