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
        const header = Buffer.alloc(80);

        // TODO: Use the midstate hash instead of hashing the whole header

        // Copy data from job to header


        header.set(Buffer.from(job.version, 'hex').subarray(0, 4), 0);
        header.set(Buffer.from(job.prevhash, 'hex').subarray(0, 32), 4);
        header.set(Buffer.from(job.merkleRoot, 'hex').subarray(0, 32), 36);
        header.set(Buffer.from(job.ntime).subarray(0, 4), 68);
        header.set(Buffer.from(job.target, 'hex').subarray(0, 4), 72);
        header.set(Buffer.from(nonce, 'hex').subarray(0, 4), 76);


        const hashBuffer = crypto.createHash('sha256').update(header).digest();
        const hashResult = crypto.createHash('sha256').update(hashBuffer).digest();

        const d64 = 1.0;
        const s64 = this.littleEndianToDouble(hashResult);
        const ds = d64 / s64;

        return ds;
    }


    private littleEndianToDouble(buffer: Buffer): number {
        // Reverse the byte order to big-endian
        const reversedBytes = Buffer.from(buffer).reverse();

        // Convert the reversed bytes to a hexadecimal string
        const hexString = `0x${reversedBytes.toString('hex')}`;

        // Interpret the hexadecimal string as a double
        const doubleValue = Number(hexString);

        // Check for NaN and Infinity
        if (!Number.isFinite(doubleValue)) {
            throw new Error('Conversion resulted in NaN or Infinity');
        }

        return doubleValue;
    }
}