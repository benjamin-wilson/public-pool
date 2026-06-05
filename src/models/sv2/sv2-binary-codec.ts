// ── SV2 Binary Codec ────────────────────────────────────────────────
// Sequential Buffer reader / accumulator-pattern writer for all SV2
// data types.  All multi-byte integers are little-endian per spec.

// ── BufferReader ────────────────────────────────────────────────────

export class BufferReader {
  private offset = 0;

  constructor(private readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  get position(): number {
    return this.offset;
  }

  private ensure(n: number): void {
    if (this.offset + n > this.buf.length) {
      throw new RangeError(
        `BufferReader: need ${n} bytes at offset ${this.offset}, only ${this.remaining} available`,
      );
    }
  }

  readBool(): boolean {
    this.ensure(1);
    return this.buf[this.offset++] !== 0;
  }

  readU8(): number {
    this.ensure(1);
    return this.buf[this.offset++];
  }

  readU16(): number {
    this.ensure(2);
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  readU24(): number {
    this.ensure(3);
    const v =
      this.buf[this.offset] |
      (this.buf[this.offset + 1] << 8) |
      (this.buf[this.offset + 2] << 16);
    this.offset += 3;
    return v;
  }

  readU32(): number {
    this.ensure(4);
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  /** Read Sv2Option<u32>: 1-byte flag (0=None, 1=Some) + optional 4-byte u32 LE */
  readOptionU32(): number | null {
    this.ensure(1);
    const flag = this.buf[this.offset++];
    if (flag === 0) return null;
    this.ensure(4);
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  readU64(): bigint {
    this.ensure(8);
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  readU256(): Buffer {
    this.ensure(32);
    const v = Buffer.from(this.buf.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return v;
  }

  readF32(): number {
    this.ensure(4);
    const v = this.buf.readFloatLE(this.offset);
    this.offset += 4;
    return v;
  }

  readBytes(n: number): Buffer {
    this.ensure(n);
    const v = Buffer.from(this.buf.subarray(this.offset, this.offset + n));
    this.offset += n;
    return v;
  }

  /** STR0_255: 1-byte length prefix + UTF-8 payload */
  readStr0_255(): string {
    const len = this.readU8();
    return this.readBytes(len).toString('utf8');
  }

  /** B0_32: 1-byte length prefix, max 32 bytes */
  readB0_32(): Buffer {
    const len = this.readU8();
    if (len > 32) throw new RangeError(`B0_32: length ${len} > 32`);
    return this.readBytes(len);
  }

  /** B0_255: 1-byte length prefix, max 255 bytes */
  readB0_255(): Buffer {
    const len = this.readU8();
    return this.readBytes(len);
  }

  /** B0_64K: 2-byte length prefix */
  readB0_64K(): Buffer {
    const len = this.readU16();
    return this.readBytes(len);
  }

  /** B0_16M: 3-byte length prefix, max 16,777,215 bytes */
  readB0_16M(): Buffer {
    const len = this.readU24();
    return this.readBytes(len);
  }

  /** SEQ0_255: 1-byte count + repeated elements */
  readSeq0_255<T>(readFn: (reader: BufferReader) => T): T[] {
    const count = this.readU8();
    const result: T[] = [];
    for (let i = 0; i < count; i++) {
      result.push(readFn(this));
    }
    return result;
  }

  /** SEQ0_64K: 2-byte count + repeated elements */
  readSeq0_64K<T>(readFn: (reader: BufferReader) => T): T[] {
    const count = this.readU16();
    const result: T[] = [];
    for (let i = 0; i < count; i++) {
      result.push(readFn(this));
    }
    return result;
  }
}

// ── BufferWriter ────────────────────────────────────────────────────

export class BufferWriter {
  private buf: Buffer;
  private offset = 0;

  constructor(initialSize = 256) {
    this.buf = Buffer.allocUnsafe(initialSize);
  }

  private ensureCapacity(n: number): void {
    if (this.offset + n > this.buf.length) {
      let newSize = this.buf.length * 2;
      while (newSize < this.offset + n) newSize *= 2;
      const newBuf = Buffer.allocUnsafe(newSize);
      this.buf.copy(newBuf, 0, 0, this.offset);
      this.buf = newBuf;
    }
  }

  writeBool(v: boolean): void {
    this.ensureCapacity(1);
    this.buf[this.offset++] = v ? 1 : 0;
  }

  writeU8(v: number): void {
    this.ensureCapacity(1);
    this.buf[this.offset++] = v & 0xff;
  }

  /** Write Sv2Option<u32>: 1-byte flag + optional 4-byte u32 LE */
  writeOptionU32(v: number | null): void {
    if (v === null) {
      this.writeU8(0);
    } else {
      this.writeU8(1);
      this.writeU32(v);
    }
  }

  writeU16(v: number): void {
    this.ensureCapacity(2);
    this.buf.writeUInt16LE(v, this.offset);
    this.offset += 2;
  }

  writeU24(v: number): void {
    this.ensureCapacity(3);
    this.buf[this.offset] = v & 0xff;
    this.buf[this.offset + 1] = (v >> 8) & 0xff;
    this.buf[this.offset + 2] = (v >> 16) & 0xff;
    this.offset += 3;
  }

  writeU32(v: number): void {
    this.ensureCapacity(4);
    this.buf.writeUInt32LE(v >>> 0, this.offset);
    this.offset += 4;
  }

  writeU64(v: bigint): void {
    this.ensureCapacity(8);
    this.buf.writeBigUInt64LE(v, this.offset);
    this.offset += 8;
  }

  writeU256(v: Buffer): void {
    if (v.length !== 32) throw new RangeError('U256 must be 32 bytes');
    this.ensureCapacity(32);
    v.copy(this.buf, this.offset);
    this.offset += 32;
  }

  writeF32(v: number): void {
    this.ensureCapacity(4);
    this.buf.writeFloatLE(v, this.offset);
    this.offset += 4;
  }

  writeBytes(v: Buffer): void {
    this.ensureCapacity(v.length);
    v.copy(this.buf, this.offset);
    this.offset += v.length;
  }

  /** STR0_255: 1-byte length prefix + UTF-8 payload */
  writeStr0_255(v: string): void {
    const payload = Buffer.from(v, 'utf8');
    if (payload.length > 255)
      throw new RangeError(`STR0_255: length ${payload.length} > 255`);
    this.writeU8(payload.length);
    this.writeBytes(payload);
  }

  /** B0_32: 1-byte length prefix, max 32 bytes */
  writeB0_32(v: Buffer): void {
    if (v.length > 32) throw new RangeError(`B0_32: length ${v.length} > 32`);
    this.writeU8(v.length);
    this.writeBytes(v);
  }

  /** B0_255: 1-byte length prefix, max 255 bytes */
  writeB0_255(v: Buffer): void {
    if (v.length > 255)
      throw new RangeError(`B0_255: length ${v.length} > 255`);
    this.writeU8(v.length);
    this.writeBytes(v);
  }

  /** B0_64K: 2-byte length prefix */
  writeB0_64K(v: Buffer): void {
    if (v.length > 65535)
      throw new RangeError(`B0_64K: length ${v.length} > 65535`);
    this.writeU16(v.length);
    this.writeBytes(v);
  }

  /** B0_16M: 3-byte length prefix, max 16,777,215 bytes */
  writeB0_16M(v: Buffer): void {
    if (v.length > 16777215)
      throw new RangeError(`B0_16M: length ${v.length} > 16777215`);
    this.writeU24(v.length);
    this.writeBytes(v);
  }

  /** SEQ0_255: 1-byte count + repeated elements */
  writeSeq0_255<T>(items: T[], writeFn: (writer: BufferWriter, item: T) => void): void {
    if (items.length > 255)
      throw new RangeError(`SEQ0_255: count ${items.length} > 255`);
    this.writeU8(items.length);
    for (const item of items) {
      writeFn(this, item);
    }
  }

  /** SEQ0_64K: 2-byte count + repeated elements */
  writeSeq0_64K<T>(items: T[], writeFn: (writer: BufferWriter, item: T) => void): void {
    if (items.length > 65535)
      throw new RangeError(`SEQ0_64K: count ${items.length} > 65535`);
    this.writeU16(items.length);
    for (const item of items) {
      writeFn(this, item);
    }
  }

  toBuffer(): Buffer {
    return Buffer.from(this.buf.subarray(0, this.offset));
  }
}
