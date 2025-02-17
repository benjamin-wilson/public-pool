import { IsString, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { IsBitcoinAddress } from './validators/bitcoin-address.validator';

export class ExternalPoolShare {
  @IsString()
  @MaxLength(64)
  worker: string;

  @IsString()
  @IsBitcoinAddress()
  address: string;

  @IsString()
  @MaxLength(128)
  userAgent: string;

  @IsString()
  @MaxLength(128)
  externalPoolName: string;

  @IsString()
  @Matches(/^[0-9a-fA-F]+$/, { 
    message: 'Header must be a valid hex string'
  })
  header: string;
}
