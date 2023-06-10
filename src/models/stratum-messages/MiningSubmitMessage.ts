import { ArrayMaxSize, ArrayMinSize, IsArray } from 'class-validator';

import { eRequestMethod } from '../enums/eRequestMethod';
import { StratumBaseMessage } from './StratumBaseMessage';

export class MiningSubmitMessage extends StratumBaseMessage {

    @IsArray()
    @ArrayMinSize(5)
    @ArrayMaxSize(5)
    params: string[];

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