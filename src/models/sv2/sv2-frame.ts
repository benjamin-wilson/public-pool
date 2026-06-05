// ── SV2 Frame Encoding / Decoding ───────────────────────────────────
// Handles 6-byte frame headers, encrypted framing with ChaCha20-Poly1305
// AEAD chunking, and incremental TCP reassembly.

import {
  SV2_HEADER_SIZE,
  SV2_MAC_SIZE,
  SV2_ENCRYPTED_HEADER_SIZE,
  SV2_MAX_PLAINTEXT_CHUNK,
  SV2_CHANNEL_MSG_FLAG,
} from './sv2-constants';

// ── Frame Header ────────────────────────────────────────────────────

export interface Sv2FrameHeader {
  extensionType: number; // U16 (includes channel msg bit)
  msgType: number; // U8
  msgLength: number; // U24 (payload byte count)
}

/**
 * Encode a 6-byte SV2 frame header.
 * extension_type[0..1] | msg_type[2] | msg_length[3..5]
 */
export function encodeFrameHeader(header: Sv2FrameHeader): Buffer {
  const buf = Buffer.alloc(SV2_HEADER_SIZE);
  buf.writeUInt16LE(header.extensionType, 0);
  buf[2] = header.msgType & 0xff;
  buf[3] = header.msgLength & 0xff;
  buf[4] = (header.msgLength >> 8) & 0xff;
  buf[5] = (header.msgLength >> 16) & 0xff;
  return buf;
}

/**
 * Decode a 6-byte SV2 frame header.
 */
export function decodeFrameHeader(buf: Buffer): Sv2FrameHeader {
  if (buf.length < SV2_HEADER_SIZE) {
    throw new RangeError(`Frame header requires ${SV2_HEADER_SIZE} bytes, got ${buf.length}`);
  }
  const extensionType = buf.readUInt16LE(0);
  const msgType = buf[2];
  const msgLength = buf[3] | (buf[4] << 8) | (buf[5] << 16);
  return { extensionType, msgType, msgLength };
}

/**
 * Check if a frame header indicates a channel message.
 */
export function isChannelMessage(header: Sv2FrameHeader): boolean {
  return (header.extensionType & SV2_CHANNEL_MSG_FLAG) !== 0;
}

// ── Ciphertext / Plaintext Size Calculations ────────────────────────

/**
 * Calculate ciphertext length from plaintext length.
 * Each chunk of up to 65519 plaintext bytes gets a 16-byte MAC.
 */
export function plaintextToCiphertextLength(plaintextLen: number): number {
  if (plaintextLen === 0) return 0;
  const fullChunks = Math.floor(plaintextLen / SV2_MAX_PLAINTEXT_CHUNK);
  const remainder = plaintextLen % SV2_MAX_PLAINTEXT_CHUNK;
  let len = fullChunks * (SV2_MAX_PLAINTEXT_CHUNK + SV2_MAC_SIZE);
  if (remainder > 0) {
    len += remainder + SV2_MAC_SIZE;
  }
  return len;
}

/**
 * Calculate plaintext length from ciphertext length.
 */
export function ciphertextToPlaintextLength(ciphertextLen: number): number {
  if (ciphertextLen === 0) return 0;
  const chunkSize = SV2_MAX_PLAINTEXT_CHUNK + SV2_MAC_SIZE;
  const fullChunks = Math.floor(ciphertextLen / chunkSize);
  const remainder = ciphertextLen % chunkSize;
  let len = fullChunks * SV2_MAX_PLAINTEXT_CHUNK;
  if (remainder > 0) {
    if (remainder <= SV2_MAC_SIZE) {
      throw new RangeError('Invalid ciphertext length: remainder chunk too small for MAC');
    }
    len += remainder - SV2_MAC_SIZE;
  }
  return len;
}

// ── Decryption / Encryption Function Types ──────────────────────────

export type DecryptFn = (ciphertext: Buffer) => Buffer;
export type EncryptFn = (plaintext: Buffer) => Buffer;

// ── Frame Reader (TCP reassembly + decryption) ──────────────────────

interface ParsedFrame {
  header: Sv2FrameHeader;
  payload: Buffer;
}

const enum ReaderState {
  READING_HEADER,
  READING_PAYLOAD,
}

export class Sv2FrameReader {
  private decryptFn: DecryptFn | null;
  private buf: Buffer = Buffer.alloc(0);
  private state = ReaderState.READING_HEADER;
  private currentHeader: Sv2FrameHeader | null = null;

  constructor(decryptFn: DecryptFn | null) {
    this.decryptFn = decryptFn;
  }

  /** Switch to encrypted mode (after handshake completes). */
  setDecryptFn(fn: DecryptFn): void {
    this.decryptFn = fn;
  }

  /** Expected header size: 22 bytes encrypted, 6 bytes plaintext. */
  private get headerSize(): number {
    return this.decryptFn ? SV2_ENCRYPTED_HEADER_SIZE : SV2_HEADER_SIZE;
  }

  /**
   * Feed incoming TCP data and return any complete frames.
   */
  feed(data: Buffer): ParsedFrame[] {
    this.buf = this.buf.length === 0 ? data : Buffer.concat([this.buf, data]);
    const frames: ParsedFrame[] = [];

    while (true) {
      if (this.state === ReaderState.READING_HEADER) {
        if (this.buf.length < this.headerSize) break;

        let headerBytes: Buffer;
        if (this.decryptFn) {
          headerBytes = this.decryptFn(this.buf.subarray(0, SV2_ENCRYPTED_HEADER_SIZE));
        } else {
          headerBytes = this.buf.subarray(0, SV2_HEADER_SIZE);
        }

        this.currentHeader = decodeFrameHeader(headerBytes);
        this.buf = Buffer.from(this.buf.subarray(this.headerSize));
        this.state = ReaderState.READING_PAYLOAD;
      }

      if (this.state === ReaderState.READING_PAYLOAD) {
        const payloadWireLen = this.decryptFn
          ? plaintextToCiphertextLength(this.currentHeader!.msgLength)
          : this.currentHeader!.msgLength;

        if (this.buf.length < payloadWireLen) break;

        let payload: Buffer;
        if (this.decryptFn && payloadWireLen > 0) {
          payload = this.decryptPayloadChunks(this.buf.subarray(0, payloadWireLen));
        } else {
          payload = Buffer.from(this.buf.subarray(0, payloadWireLen));
        }

        frames.push({ header: this.currentHeader!, payload });
        this.buf = Buffer.from(this.buf.subarray(payloadWireLen));
        this.currentHeader = null;
        this.state = ReaderState.READING_HEADER;
      }
    }

    return frames;
  }

  private decryptPayloadChunks(ciphertext: Buffer): Buffer {
    const chunkSize = SV2_MAX_PLAINTEXT_CHUNK + SV2_MAC_SIZE;
    const parts: Buffer[] = [];
    let offset = 0;

    while (offset < ciphertext.length) {
      const remaining = ciphertext.length - offset;
      const thisChunkLen = Math.min(remaining, chunkSize);
      const chunk = ciphertext.subarray(offset, offset + thisChunkLen);
      parts.push(this.decryptFn!(Buffer.from(chunk)));
      offset += thisChunkLen;
    }

    return Buffer.concat(parts);
  }
}

// ── Frame Writer (serialization + encryption) ───────────────────────

export class Sv2FrameWriter {
  private encryptFn: EncryptFn | null;

  constructor(encryptFn: EncryptFn | null) {
    this.encryptFn = encryptFn;
  }

  /** Switch to encrypted mode (after handshake completes). */
  setEncryptFn(fn: EncryptFn): void {
    this.encryptFn = fn;
  }

  /**
   * Encode a complete frame (header + payload) ready for the wire.
   */
  writeFrame(header: Sv2FrameHeader, payload: Buffer): Buffer {
    const headerBuf = encodeFrameHeader(header);

    if (!this.encryptFn) {
      return Buffer.concat([headerBuf, payload]);
    }

    // Encrypt header
    const encHeader = this.encryptFn(headerBuf);

    // Encrypt payload in chunks
    const parts: Buffer[] = [encHeader];
    let offset = 0;

    while (offset < payload.length) {
      const remaining = payload.length - offset;
      const chunkLen = Math.min(remaining, SV2_MAX_PLAINTEXT_CHUNK);
      const chunk = payload.subarray(offset, offset + chunkLen);
      parts.push(this.encryptFn(Buffer.from(chunk)));
      offset += chunkLen;
    }

    return Buffer.concat(parts);
  }
}
