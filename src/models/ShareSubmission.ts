import { IsString, IsDate, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { IsBitcoinAddress } from './validators/bitcoin-address.validator';

export class ShareSubmission {
  @IsString()
  @MaxLength(64)
  @Transform(({ value, key, obj, type }) => {
    return obj.params[0].split('.')[1] == null ? 'worker' : obj.params[0].split('.')[1];
  })
  worker: string;

  @IsString()
  @Transform(({ value, key, obj, type }) => {
    return obj.params[0].split('.')[0];
  })
  @IsBitcoinAddress()
  address: string;

  @IsString()
  @MaxLength(128)
  userAgent: string;

  @IsString()
  @Matches(/^[0-9a-fA-F]+$/, { 
    message: 'Header must be a valid hex string'
  })
  header: string;
}
