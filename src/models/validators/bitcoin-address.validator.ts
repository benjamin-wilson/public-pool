import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validate } from 'bitcoin-address-validation';
import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'bitcoinAddress', async: false })
@Injectable()
export class BitcoinAddressValidator implements ValidatorConstraintInterface {
  constructor(private configService: ConfigService) {}

  validate(value: string): boolean {
    return validate(value, this.configService.get('NETWORK'));
  }

  defaultMessage(): string {
    return 'Must be a bitcoin address';
  }
}

export function IsBitcoinAddress(validationOptions?: ValidationOptions) {
  return function (object: Object, propertyName: string) {
    registerDecorator({
      name: 'isBitcoinAddress',
      target: object.constructor,
      propertyName: propertyName,
      constraints: [],
      options: validationOptions,
      validator: BitcoinAddressValidator,
    });
  };
}
