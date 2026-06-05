import { sipHash24, shortTxId, sipHashKeyFromNonce } from './sv2-siphash';

describe('SipHash-2-4', () => {
  // Official SipHash-2-4 test vectors from the reference paper
  // Key: 00 01 02 ... 0f
  // Input: empty, 00, 00 01, 00 01 02, ...
  // Expected outputs (first few from Appendix A of the paper)
  const testKey = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

  // Reference vectors from vectors.h: uint8_t vectors_sip64[64][8]
  // These are the raw output bytes, so we compare directly with our output buffer.
  const expectedOutputs = [
    '310e0edd47db6f72', // empty input
    'fd67dc93c539f874', // [0x00]
    '5a4fa9d909806c0d', // [0x00, 0x01]
    '2d7efbd796666785', // [0x00, 0x01, 0x02]
    'b7877127e09427cf', // [0x00, 0x01, 0x02, 0x03]
    '8da699cd64557618', // [0x00, ..., 0x04]
    'cee3fe586e46c9cb', // [0x00, ..., 0x05]
    '37d1018bf50002ab', // [0x00, ..., 0x06]
    '6224939a79f5f593', // [0x00, ..., 0x07]
    'b0e4a90bdf82009e', // [0x00, ..., 0x08]
    'f3b9dd94c5bb5d7a', // [0x00, ..., 0x09]
    'a7ad6b22462fb3f4', // [0x00, ..., 0x0a]
    'fbe50e86bc8f1e75', // [0x00, ..., 0x0b]
    '903d84c02756ea14', // [0x00, ..., 0x0c]
    'eef27a8e90ca23f7', // [0x00, ..., 0x0d]
    'e545be4961ca29a1', // [0x00, ..., 0x0e]
  ];

  expectedOutputs.forEach((expected, i) => {
    it(`matches test vector for ${i}-byte input`, () => {
      const input = Buffer.from(Array.from({ length: i }, (_, j) => j));
      const result = sipHash24(testKey, input);
      // Compare raw output bytes directly
      expect(result.toString('hex')).toBe(expected);
    });
  });

  it('throws for invalid key length', () => {
    expect(() => sipHash24(Buffer.alloc(8), Buffer.alloc(0))).toThrow('SipHash key must be 16 bytes');
    expect(() => sipHash24(Buffer.alloc(32), Buffer.alloc(0))).toThrow('SipHash key must be 16 bytes');
  });

  it('produces 8-byte output', () => {
    const result = sipHash24(testKey, Buffer.from('hello'));
    expect(result.length).toBe(8);
  });

  it('produces consistent results', () => {
    const data = Buffer.from('test data');
    const r1 = sipHash24(testKey, data);
    const r2 = sipHash24(testKey, data);
    expect(r1).toEqual(r2);
  });

  it('different keys produce different results', () => {
    const key2 = Buffer.alloc(16, 0xff);
    const data = Buffer.from('hello');
    const r1 = sipHash24(testKey, data);
    const r2 = sipHash24(key2, data);
    expect(r1).not.toEqual(r2);
  });

  describe('shortTxId', () => {
    it('produces 6-byte output', () => {
      const txHash = Buffer.alloc(32, 0xab);
      const result = shortTxId(testKey, txHash);
      expect(result.length).toBe(6);
    });

    it('is the first 6 bytes of sipHash24', () => {
      const txHash = Buffer.alloc(32, 0xcd);
      const full = sipHash24(testKey, txHash);
      const short = shortTxId(testKey, txHash);
      expect(short).toEqual(full.subarray(0, 6));
    });

    it('different tx hashes produce different short IDs', () => {
      const tx1 = Buffer.alloc(32, 0x01);
      const tx2 = Buffer.alloc(32, 0x02);
      const s1 = shortTxId(testKey, tx1);
      const s2 = shortTxId(testKey, tx2);
      expect(s1).not.toEqual(s2);
    });
  });

  describe('sipHashKeyFromNonce', () => {
    it('produces 16-byte key', () => {
      const key = sipHashKeyFromNonce(42n);
      expect(key.length).toBe(16);
    });

    it('nonce is stored in first 8 bytes LE', () => {
      const key = sipHashKeyFromNonce(0x0102030405060708n);
      expect(key.readBigUInt64LE(0)).toBe(0x0102030405060708n);
      // Second 8 bytes should be zero
      expect(key.readBigUInt64LE(8)).toBe(0n);
    });

    it('produces valid SipHash key', () => {
      const key = sipHashKeyFromNonce(12345n);
      const result = sipHash24(key, Buffer.from('test'));
      expect(result.length).toBe(8);
    });
  });
});
