// ── SipHash-2-4 ────────────────────────────────────────────────────
// Pure TypeScript implementation of SipHash-2-4 for SV2 JDP short
// transaction IDs. Produces 8-byte (64-bit) hashes, truncated to
// 6 bytes per the SV2 spec for SHORT_TX_ID.
//
// Reference: https://131002.net/siphash/siphash.pdf

function add64(a: [number, number], b: [number, number]): [number, number] {
  const lo = (a[1] + b[1]) >>> 0;
  const hi = ((a[0] + b[0]) >>> 0) + (lo < a[1] ? 1 : 0);
  return [(hi >>> 0), lo];
}

function rotl64(v: [number, number], n: number): [number, number] {
  if (n === 0) return v;
  if (n === 32) return [v[1], v[0]];
  if (n < 32) {
    return [
      ((v[0] << n) | (v[1] >>> (32 - n))) >>> 0,
      ((v[1] << n) | (v[0] >>> (32 - n))) >>> 0,
    ];
  }
  const s = n - 32;
  return [
    ((v[1] << s) | (v[0] >>> (32 - s))) >>> 0,
    ((v[0] << s) | (v[1] >>> (32 - s))) >>> 0,
  ];
}

function xor64(a: [number, number], b: [number, number]): [number, number] {
  return [(a[0] ^ b[0]) >>> 0, (a[1] ^ b[1]) >>> 0];
}

function sipRound(
  v0: [number, number],
  v1: [number, number],
  v2: [number, number],
  v3: [number, number],
): [[number, number], [number, number], [number, number], [number, number]] {
  v0 = add64(v0, v1);
  v1 = rotl64(v1, 13);
  v1 = xor64(v1, v0);
  v0 = rotl64(v0, 32);

  v2 = add64(v2, v3);
  v3 = rotl64(v3, 16);
  v3 = xor64(v3, v2);

  v2 = add64(v2, v1);
  v1 = rotl64(v1, 17);
  v1 = xor64(v1, v2);
  v2 = rotl64(v2, 32);

  v0 = add64(v0, v3);
  v3 = rotl64(v3, 21);
  v3 = xor64(v3, v0);

  return [v0, v1, v2, v3];
}

function readU64LE(buf: Buffer, offset: number): [number, number] {
  const lo = buf.readUInt32LE(offset);
  const hi = buf.readUInt32LE(offset + 4);
  return [hi, lo];
}

/**
 * SipHash-2-4 producing an 8-byte hash.
 * @param key 16-byte key
 * @param data input data
 * @returns 8-byte Buffer (little-endian hash)
 */
export function sipHash24(key: Buffer, data: Buffer): Buffer {
  if (key.length !== 16) throw new Error('SipHash key must be 16 bytes');

  const k0 = readU64LE(key, 0);
  const k1 = readU64LE(key, 8);

  let v0: [number, number] = xor64(k0, [0x736f6d65, 0x70736575]); // "somepseu"
  let v1: [number, number] = xor64(k1, [0x646f7261, 0x6e646f6d]); // "dorandom"
  let v2: [number, number] = xor64(k0, [0x6c796765, 0x6e657261]); // "lygenera"
  let v3: [number, number] = xor64(k1, [0x74656462, 0x79746573]); // "tedbytes"

  const len = data.length;
  const blocks = Math.floor(len / 8);

  // Process 8-byte blocks
  for (let i = 0; i < blocks; i++) {
    const m = readU64LE(data, i * 8);
    v3 = xor64(v3, m);
    // 2 rounds (SipHash-2-4)
    [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
    [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
    v0 = xor64(v0, m);
  }

  // Last block: remaining bytes + length in the high byte
  const remaining = len - blocks * 8;
  let last: [number, number] = [0, 0];

  // High byte of hi word = (len & 0xff) << 24
  last[0] = ((len & 0xff) << 24) >>> 0;

  // Read remaining bytes
  const offset = blocks * 8;
  if (remaining >= 7) last[0] |= (data[offset + 6] << 16) >>> 0;
  if (remaining >= 6) last[0] |= (data[offset + 5] << 8) >>> 0;
  if (remaining >= 5) last[0] |= data[offset + 4];
  if (remaining >= 4) last[1] = (last[1] | ((data[offset + 3] << 24) >>> 0)) >>> 0;
  if (remaining >= 3) last[1] = (last[1] | ((data[offset + 2] << 16) >>> 0)) >>> 0;
  if (remaining >= 2) last[1] = (last[1] | ((data[offset + 1] << 8) >>> 0)) >>> 0;
  if (remaining >= 1) last[1] = (last[1] | data[offset]) >>> 0;

  v3 = xor64(v3, last);
  [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
  [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
  v0 = xor64(v0, last);

  // Finalization
  v2 = xor64(v2, [0, 0xff]);
  [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
  [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
  [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
  [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);

  const result = xor64(xor64(v0, v1), xor64(v2, v3));

  const out = Buffer.alloc(8);
  out.writeUInt32LE(result[1], 0);
  out.writeUInt32LE(result[0], 4);
  return out;
}

/**
 * Compute a 6-byte SHORT_TX_ID per SV2 spec.
 * SipHash-2-4(key, txid) truncated to first 6 bytes.
 * @param key 16-byte key (derived from nonce)
 * @param txHash 32-byte transaction hash
 * @returns 6-byte Buffer
 */
export function shortTxId(key: Buffer, txHash: Buffer): Buffer {
  const hash = sipHash24(key, txHash);
  return hash.subarray(0, 6);
}

/**
 * Build a 16-byte SipHash key from a U64 nonce.
 * First 8 bytes = nonce LE, second 8 bytes = zeros.
 */
export function sipHashKeyFromNonce(nonce: bigint): Buffer {
  const key = Buffer.alloc(16);
  key.writeBigUInt64LE(nonce, 0);
  return key;
}
