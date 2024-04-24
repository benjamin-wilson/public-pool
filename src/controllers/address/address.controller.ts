import { Controller, Patch } from '@nestjs/common';
import * as bitcoinMessage from 'bitcoinjs-message';

@Controller('address')
export class AddressController {
  @Patch('settings')
  async settings() {
    const publicKey = '...'; // Public key corresponding to the private key used for signing
    const message = '...'; // The message that was signed
    const signature = '...'; // The signature of the message

    const isValid: boolean = bitcoinMessage.verify(
      message,
      publicKey,
      signature,
    );
    if (isValid) {
      console.log('Signature is valid!');
    } else {
      console.log('Signature is not valid!');
    }
  }
}
