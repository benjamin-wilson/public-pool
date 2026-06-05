import * as bs58 from 'bs58';
import * as crypto from 'crypto';

const AUTHORITY_KEY_VERSION_PREFIX = Buffer.from([1, 0]);

export function encodeSv2AuthorityPublicKey(publicKey: Buffer): string {
  if (publicKey.length !== 32) {
    throw new RangeError(`SV2 authority public key must be 32 bytes, got ${publicKey.length}`);
  }

  const versionedKey = Buffer.concat([AUTHORITY_KEY_VERSION_PREFIX, publicKey]);
  const checksum = crypto
    .createHash('sha256')
    .update(crypto.createHash('sha256').update(versionedKey).digest())
    .digest()
    .subarray(0, 4);

  return bs58.encode(Buffer.concat([versionedKey, checksum]));
}
