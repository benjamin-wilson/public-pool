import { validate } from 'bitcoin-address-validation';
import { registerDecorator, ValidationOptions, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';

@ValidatorConstraint({ name: 'bitcoinAddress', async: false })
export class BitcoinAddress implements ValidatorConstraintInterface {
    validate(value: string): boolean {
        // Implement your custom validation logic here
        return validate(value);
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
            validator: BitcoinAddress,
        });
    };
}