import { ArrayMaxSize, ArrayMinSize, IsArray } from 'class-validator';

import { eRequestMethod } from '../enums/eRequestMethod';
import { StratumBaseMessage } from './StratumBaseMessage';

export class AuthorizationMessage extends StratumBaseMessage {

    @IsArray()
    @ArrayMinSize(2)
    @ArrayMaxSize(2)
    params: string[];

    public username: string;

    public password: string;

    constructor() {
        super();
        this.method = eRequestMethod.AUTHORIZE;

    }

    public parse() {
        this.username = this.params[0];
        this.password = this.params[1];
        console.log(`Username ${this.username}, Password: ${this.password}`);
    }

    public response() {
        return {
            id: null,
            error: null,
            result: true
        };
    }
}