import { ArrayMaxSize, ArrayMinSize, IsArray, IsNumber } from 'class-validator';

import { eRequestMethod } from '../enums/eRequestMethod';
import { eResponseMethod } from '../enums/eResponseMethod';
import { StratumBaseMessage } from './StratumBaseMessage';

export class SuggestDifficulty extends StratumBaseMessage {
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(1)
    @IsNumber({}, { each: true })
    params: string[];

    constructor() {
        super();
        this.method = eRequestMethod.SUGGEST_DIFFICULTY;
    }

    public response() {
        return {
            id: null,
            method: eResponseMethod.SET_DIFFICULTY,
            params: [256]
        }
    }
}