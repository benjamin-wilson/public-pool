import { IsEnum, IsNumber } from 'class-validator';

import { eRequestMethod } from '../enums/eRequestMethod';

export class StratumBaseMessage {
    id?: number | string = null;
    @IsEnum(eRequestMethod)
    method: eRequestMethod;
}