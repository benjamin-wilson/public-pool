import { Expose, Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString } from 'class-validator';

import { eRequestMethod } from '../enums/eRequestMethod';
import { StratumBaseMessage } from './StratumBaseMessage';

export class AuthorizationMessage extends StratumBaseMessage {

    @IsArray()
    @ArrayMinSize(2)
    @ArrayMaxSize(2)
    params: string[];

    @Expose()
    @IsString()
    @Transform(({ value, key, obj, type }) => {
        return obj.params[0];
    })
    public username: string;

    @Expose()
    @IsString()
    @Transform(({ value, key, obj, type }) => {
        return obj.params[1];
    })
    public password: string;

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
}