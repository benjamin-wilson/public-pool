import { Expose, Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, Length, Matches } from 'class-validator';

import { eRequestMethod } from '../enums/eRequestMethod';
import { EXTRANONCE2_SIZE_BYTES } from '../stratum.constants';
import { StratumBaseMessage } from './StratumBaseMessage';
import { hash256 } from '../../utils/hash.utils';


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
    @Length(EXTRANONCE2_SIZE_BYTES * 2, EXTRANONCE2_SIZE_BYTES * 2)
    @Matches(/^[0-9a-fA-F]+$/)
    @Transform(({ value, key, obj, type }) => {
        return obj.params[2];
    })
    public extraNonce2: string;
    @Expose()
    @IsString()
    @Length(8, 8)
    @Matches(/^[0-9a-fA-F]{8}$/)
    @Transform(({ value, key, obj, type }) => {
        return obj.params[3];
    })
    public ntime: string;
    @Expose()
    @IsString()
    @Length(8, 8)
    @Matches(/^[0-9a-fA-F]{8}$/)
    @Transform(({ value, key, obj, type }) => {
        return obj.params[4];
    })
    public nonce: string

    @Expose()
    @IsString()
    @Length(8, 8)
    @Matches(/^[0-9a-fA-F]{8}$/)
    @Transform(({ value, key, obj, type }) => {
        return obj.params[5] == null ? '00000000' : obj.params[5];
    })
    public versionMask?: string | null;

    constructor() {
        super();
        this.method = eRequestMethod.AUTHORIZE;
    }


    public response() {
        return {
            id: this.id,
            error: null,
            result: true
        };
    }

    public hash(): string{
        const buffer = Buffer.from(this.versionMask + this.nonce + this.extraNonce2 + this.ntime + this.jobId);
        return hash256(buffer).toString('base64');
    }






}
