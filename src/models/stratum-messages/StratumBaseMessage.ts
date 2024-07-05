import { IsDefined, IsEnum, IsNumber, IsNumberString, isNumberString, IsOptional } from 'class-validator';

import { eRequestMethod } from '../enums/eRequestMethod';

export class StratumBaseMessage {
    @IsDefined()
    id?: number | string = null;
    @IsEnum(eRequestMethod)
    method: eRequestMethod;
}