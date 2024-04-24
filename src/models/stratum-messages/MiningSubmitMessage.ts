import { Expose, Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString } from 'class-validator';

import { eRequestMethod } from '../enums/eRequestMethod';
import { StratumBaseMessage } from './StratumBaseMessage';

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
  @Transform(({ value, key, obj, type }) => {
    return obj.params[2];
  })
  public extraNonce2: string;
  @Expose()
  @IsString()
  @Transform(({ value, key, obj, type }) => {
    return obj.params[3];
  })
  public ntime: string;
  @Expose()
  @IsString()
  @Transform(({ value, key, obj, type }) => {
    return obj.params[4];
  })
  public nonce: string;

  @Expose()
  @IsString()
  @Transform(({ value, key, obj, type }) => {
    return obj.params[5] == null ? '0' : obj.params[5];
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
      result: true,
    };
  }
}
