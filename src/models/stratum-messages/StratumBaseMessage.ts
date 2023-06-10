import { IsEnum, IsNumber } from 'class-validator';

import { eRequestMethod } from '../enums/eRequestMethod';

export class StratumBaseMessage {
    @IsNumber()
    id: number;
    @IsEnum(eRequestMethod)
    method: eRequestMethod;
}