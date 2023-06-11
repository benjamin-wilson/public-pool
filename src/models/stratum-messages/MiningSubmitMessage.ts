import { ArrayMaxSize, ArrayMinSize, IsArray } from 'class-validator';

import { eRequestMethod } from '../enums/eRequestMethod';
import { StratumBaseMessage } from './StratumBaseMessage';
import { MiningJob } from '../MiningJob';
import * as crypto from 'crypto';

const trueDiffOne = Number('26959535291011309493156476344723991336010898738574164086137773096960');
export class MiningSubmitMessage extends StratumBaseMessage {

    @IsArray()
    @ArrayMinSize(5)
    @ArrayMaxSize(5)
    params: string[];

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


    testNonceValue(job: MiningJob, nonce: string): number {

        const header: Buffer = Buffer.alloc(80);

        // TODO: use the midstate hash instead of hashing the whole header


        header.set(Buffer.from(job.version).subarray(0, 4), 0);
        header.set(Buffer.from(job.prevhash).subarray(0, 32), 4);
        header.set(Buffer.from(job.merkleRoot).subarray(0, 32), 36);
        header.set(Buffer.from(job.ntime).subarray(0, 4), 68);
        header.set(Buffer.from(job.target).subarray(0, 4), 72);
        header.set(Buffer.from(nonce).subarray(0, 4), 76);


        const hashBuffer = crypto.createHash('sha256').update(header).digest();
        const hashResult = crypto.createHash('sha256').update(hashBuffer).digest();

        const s64 = this.le256toDouble(hashResult);
        const ds = trueDiffOne / s64;
        console.log(trueDiffOne + '/ ' + s64)
        return ds;
    }


    private le256toDouble(target: Buffer): number {
        const bits192 = 6277101735386680763835789423207666416102355444464034512896n; // Replace with the actual value of bits192
        const bits128 = 340282366920938463463374607431768211456n; // Replace with the actual value of bits128
        const bits64 = 18446744073709551616n; // Replace with the actual value of bits64

        const data64 = target.readBigUInt64LE(24);
        let dcut64 = Number(data64) * Number(bits192);

        dcut64 += Number(target.readBigUInt64LE(16)) * Number(bits128);
        dcut64 += Number(target.readBigUInt64LE(8)) * Number(bits64);
        dcut64 += Number(target.readBigUInt64LE(0));

        return dcut64;
    }
}