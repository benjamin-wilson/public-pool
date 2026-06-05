import { encodeSv2AuthorityPublicKey } from './sv2-authority-key';

describe('SV2 authority key encoding', () => {
  it('matches the protocol security test vector', () => {
    const rawPublicKey = Buffer.from([
      118, 99, 112, 0, 151, 156, 28, 17,
      175, 12, 48, 11, 205, 140, 127, 228,
      134, 16, 252, 233, 185, 193, 30, 61,
      174, 227, 90, 224, 176, 138, 116, 85,
    ]);

    expect(encodeSv2AuthorityPublicKey(rawPublicKey))
      .toBe('9bXiEd8boQVhq7WddEcERUL5tyyJVFYdU8th3HfbNXK3Yw6GRXh');
  });

  it('rejects non-x-only public keys', () => {
    expect(() => encodeSv2AuthorityPublicKey(Buffer.alloc(33))).toThrow(RangeError);
  });
});
