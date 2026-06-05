import { BufferReader, BufferWriter } from './sv2-binary-codec';

describe('SV2 Binary Codec', () => {
  // ── Round-trip Tests ────────────────────────────────────────────────

  describe('BufferWriter + BufferReader round-trips', () => {
    it('should round-trip Bool', () => {
      const w = new BufferWriter();
      w.writeBool(true);
      w.writeBool(false);
      const r = new BufferReader(w.toBuffer());
      expect(r.readBool()).toBe(true);
      expect(r.readBool()).toBe(false);
    });

    it('should round-trip U8', () => {
      const w = new BufferWriter();
      w.writeU8(0);
      w.writeU8(255);
      w.writeU8(42);
      const r = new BufferReader(w.toBuffer());
      expect(r.readU8()).toBe(0);
      expect(r.readU8()).toBe(255);
      expect(r.readU8()).toBe(42);
    });

    it('should round-trip U16', () => {
      const w = new BufferWriter();
      w.writeU16(0);
      w.writeU16(65535);
      w.writeU16(1234);
      const r = new BufferReader(w.toBuffer());
      expect(r.readU16()).toBe(0);
      expect(r.readU16()).toBe(65535);
      expect(r.readU16()).toBe(1234);
    });

    it('should round-trip U24', () => {
      const w = new BufferWriter();
      w.writeU24(0);
      w.writeU24(0xffffff);
      w.writeU24(123456);
      const r = new BufferReader(w.toBuffer());
      expect(r.readU24()).toBe(0);
      expect(r.readU24()).toBe(0xffffff);
      expect(r.readU24()).toBe(123456);
    });

    it('should round-trip U32', () => {
      const w = new BufferWriter();
      w.writeU32(0);
      w.writeU32(0xffffffff);
      w.writeU32(305419896);
      const r = new BufferReader(w.toBuffer());
      expect(r.readU32()).toBe(0);
      expect(r.readU32()).toBe(0xffffffff);
      expect(r.readU32()).toBe(305419896);
    });

    it('should round-trip U64', () => {
      const w = new BufferWriter();
      w.writeU64(0n);
      w.writeU64(0xffffffffffffffffn);
      w.writeU64(123456789012345678n);
      const r = new BufferReader(w.toBuffer());
      expect(r.readU64()).toBe(0n);
      expect(r.readU64()).toBe(0xffffffffffffffffn);
      expect(r.readU64()).toBe(123456789012345678n);
    });

    it('should round-trip U256', () => {
      const val = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) val[i] = i;
      const w = new BufferWriter();
      w.writeU256(val);
      const r = new BufferReader(w.toBuffer());
      expect(r.readU256()).toEqual(val);
    });

    it('should round-trip F32', () => {
      const w = new BufferWriter();
      w.writeF32(3.14);
      w.writeF32(0);
      w.writeF32(-1.5);
      const r = new BufferReader(w.toBuffer());
      expect(r.readF32()).toBeCloseTo(3.14, 2);
      expect(r.readF32()).toBe(0);
      expect(r.readF32()).toBe(-1.5);
    });

    it('should round-trip Str0_255', () => {
      const w = new BufferWriter();
      w.writeStr0_255('');
      w.writeStr0_255('hello');
      w.writeStr0_255('mining/pool/1.0');
      const r = new BufferReader(w.toBuffer());
      expect(r.readStr0_255()).toBe('');
      expect(r.readStr0_255()).toBe('hello');
      expect(r.readStr0_255()).toBe('mining/pool/1.0');
    });

    it('should round-trip B0_32', () => {
      const val = Buffer.from([1, 2, 3, 4]);
      const w = new BufferWriter();
      w.writeB0_32(Buffer.alloc(0));
      w.writeB0_32(val);
      const r = new BufferReader(w.toBuffer());
      expect(r.readB0_32()).toEqual(Buffer.alloc(0));
      expect(r.readB0_32()).toEqual(val);
    });

    it('should round-trip B0_255', () => {
      const val = Buffer.alloc(100, 0xab);
      const w = new BufferWriter();
      w.writeB0_255(val);
      const r = new BufferReader(w.toBuffer());
      expect(r.readB0_255()).toEqual(val);
    });

    it('should round-trip B0_64K', () => {
      const val = Buffer.alloc(1000, 0xcd);
      const w = new BufferWriter();
      w.writeB0_64K(val);
      const r = new BufferReader(w.toBuffer());
      expect(r.readB0_64K()).toEqual(val);
    });

    it('should round-trip Seq0_255', () => {
      const items = [10, 20, 30];
      const w = new BufferWriter();
      w.writeSeq0_255(items, (wr, v) => wr.writeU32(v));
      const r = new BufferReader(w.toBuffer());
      const result = r.readSeq0_255((rd) => rd.readU32());
      expect(result).toEqual(items);
    });

    it('should round-trip Seq0_64K', () => {
      const items = ['alpha', 'beta'];
      const w = new BufferWriter();
      w.writeSeq0_64K(items, (wr, v) => wr.writeStr0_255(v));
      const r = new BufferReader(w.toBuffer());
      const result = r.readSeq0_64K((rd) => rd.readStr0_255());
      expect(result).toEqual(items);
    });
  });

  // ── Little-endian Verification ──────────────────────────────────────

  describe('little-endian encoding', () => {
    it('U16 should be little-endian', () => {
      const w = new BufferWriter();
      w.writeU16(0x0102);
      const buf = w.toBuffer();
      expect(buf[0]).toBe(0x02); // low byte first
      expect(buf[1]).toBe(0x01);
    });

    it('U32 should be little-endian', () => {
      const w = new BufferWriter();
      w.writeU32(0x01020304);
      const buf = w.toBuffer();
      expect(buf[0]).toBe(0x04);
      expect(buf[1]).toBe(0x03);
      expect(buf[2]).toBe(0x02);
      expect(buf[3]).toBe(0x01);
    });
  });

  // ── Bounds Checking ─────────────────────────────────────────────────

  describe('bounds checking', () => {
    it('BufferReader should throw on underflow', () => {
      const r = new BufferReader(Buffer.alloc(1));
      r.readU8(); // consumes the one byte
      expect(() => r.readU8()).toThrow(RangeError);
    });

    it('BufferReader should throw when reading U32 from 2-byte buffer', () => {
      const r = new BufferReader(Buffer.alloc(2));
      expect(() => r.readU32()).toThrow(RangeError);
    });

    it('B0_32 should reject payloads > 32 bytes', () => {
      const w = new BufferWriter();
      expect(() => w.writeB0_32(Buffer.alloc(33))).toThrow(RangeError);
    });

    it('B0_32 reader should reject length > 32', () => {
      // Craft a buffer with length prefix = 33
      const buf = Buffer.alloc(34);
      buf[0] = 33;
      const r = new BufferReader(buf);
      expect(() => r.readB0_32()).toThrow(RangeError);
    });

    it('U256 writer should reject non-32-byte buffers', () => {
      const w = new BufferWriter();
      expect(() => w.writeU256(Buffer.alloc(31))).toThrow(RangeError);
    });

    it('Str0_255 should reject strings > 255 bytes', () => {
      const w = new BufferWriter();
      expect(() => w.writeStr0_255('a'.repeat(256))).toThrow(RangeError);
    });

    it('remaining should track consumed bytes', () => {
      const r = new BufferReader(Buffer.alloc(10));
      expect(r.remaining).toBe(10);
      r.readU32();
      expect(r.remaining).toBe(6);
      expect(r.position).toBe(4);
    });
  });

  // ── Edge Cases ──────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('empty buffer reader has 0 remaining', () => {
      const r = new BufferReader(Buffer.alloc(0));
      expect(r.remaining).toBe(0);
    });

    it('empty Seq0_255 round-trips', () => {
      const w = new BufferWriter();
      w.writeSeq0_255([], (wr, v) => wr.writeU8(v as number));
      const r = new BufferReader(w.toBuffer());
      expect(r.readSeq0_255((rd) => rd.readU8())).toEqual([]);
    });

    it('maximum B0_32 (32 bytes) round-trips', () => {
      const val = Buffer.alloc(32, 0xff);
      const w = new BufferWriter();
      w.writeB0_32(val);
      const r = new BufferReader(w.toBuffer());
      expect(r.readB0_32()).toEqual(val);
    });

    it('writeU32 handles signed int32 from bitcoinjs block.version', () => {
      // bitcoinjs-lib stores block.version as signed Int32 (readInt32).
      // Version rolling or BIP9 signaling can set bit 31, producing
      // a negative JS number. writeU32 must handle this via >>> 0.
      const signedVersion = -1554660091; // 0xA355C505 unsigned
      const w = new BufferWriter();
      w.writeU32(signedVersion);
      const r = new BufferReader(w.toBuffer());
      expect(r.readU32()).toBe(0xA355C505);
    });
  });
});
