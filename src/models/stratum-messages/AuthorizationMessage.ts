import { Expose, Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

import { eRequestMethod } from '../enums/eRequestMethod';
import { IsBitcoinAddress } from '../validators/bitcoin-address.validator';
import { StratumBaseMessage } from './StratumBaseMessage';

export class AuthorizationMessage extends StratumBaseMessage {

    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(2)
    params: string[];

    @Expose()
    @IsString()
    @Transform(({ value, key, obj, type }) => {
        return obj.params[0].split('.')[0];
    })
    @IsBitcoinAddress()
    public address: string;

    @Expose()
    @IsString()
    @MaxLength(64)
    @Transform(({ value, key, obj, type }) => {
        const workerName = obj.params[0].split('.')[1];
        if (workerName == null) {
            return 'worker';
        }
        return workerName;
    })
    public worker: string;


    @Expose()
    @IsNumber()
    @Transform(({ value, key, obj, type }) => {
        const password: string | null = obj.params[1];
        if (password?.includes('d=')) {
            return parseInt(password.split('d=')[1]);
        }
        return null;
    })
    @IsOptional()
    public startingDiff: number;


    @Expose()
    @IsString()
    @Transform(({ value, key, obj, type }) => {
        return obj.params[1];
    })
    @MaxLength(64)
    @IsOptional()
    public password?: string;

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
}