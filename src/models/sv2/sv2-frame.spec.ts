import {
  encodeFrameHeader,
  decodeFrameHeader,
  isChannelMessage,
  plaintextToCiphertextLength,
  ciphertextToPlaintextLength,
  Sv2FrameReader,
  Sv2FrameWriter,
  Sv2FrameHeader,
} from './sv2-frame';
import { SV2_CHANNEL_MSG_FLAG, SV2_MAC_SIZE, SV2_MAX_PLAINTEXT_CHUNK } from './sv2-constants';

describe('SV2 Frame', () => {
  // ── Header Encode / Decode ──────────────────────────────────────────

  describe('frame header', () => {
    it('should encode and decode a basic header', () => {
      const header: Sv2FrameHeader = {
        extensionType: 0x0000,
        msgType: 0x10,
        msgLength: 42,
      };
      const buf = encodeFrameHeader(header);
      expect(buf.length).toBe(6);
      const decoded = decodeFrameHeader(buf);
      expect(decoded).toEqual(header);
    });

    it('should handle max msgLength (24-bit)', () => {
      const header: Sv2FrameHeader = {
        extensionType: 0,
        msgType: 0xff,
        msgLength: 0xffffff,
      };
      const buf = encodeFrameHeader(header);
      const decoded = decodeFrameHeader(buf);
      expect(decoded.msgLength).toBe(0xffffff);
    });

    it('should preserve channel message flag', () => {
      const header: Sv2FrameHeader = {
        extensionType: SV2_CHANNEL_MSG_FLAG | 0x01,
        msgType: 0x1a,
        msgLength: 24,
      };
      const buf = encodeFrameHeader(header);
      const decoded = decodeFrameHeader(buf);
      expect(decoded.extensionType).toBe(SV2_CHANNEL_MSG_FLAG | 0x01);
      expect(isChannelMessage(decoded)).toBe(true);
    });

    it('should detect non-channel messages', () => {
      const header: Sv2FrameHeader = {
        extensionType: 0x0000,
        msgType: 0x00,
        msgLength: 10,
      };
      expect(isChannelMessage(header)).toBe(false);
    });

    it('should throw on buffer too short', () => {
      expect(() => decodeFrameHeader(Buffer.alloc(5))).toThrow(RangeError);
    });
  });

  // ── Ciphertext Length Calculations ──────────────────────────────────

  describe('ciphertext length calculations', () => {
    it('should return 0 for 0-length plaintext', () => {
      expect(plaintextToCiphertextLength(0)).toBe(0);
      expect(ciphertextToPlaintextLength(0)).toBe(0);
    });

    it('should add one MAC for small payload', () => {
      expect(plaintextToCiphertextLength(100)).toBe(100 + SV2_MAC_SIZE);
    });

    it('should handle exactly one full chunk', () => {
      const ct = plaintextToCiphertextLength(SV2_MAX_PLAINTEXT_CHUNK);
      expect(ct).toBe(SV2_MAX_PLAINTEXT_CHUNK + SV2_MAC_SIZE);
    });

    it('should handle one full chunk + 1 byte remainder', () => {
      const ct = plaintextToCiphertextLength(SV2_MAX_PLAINTEXT_CHUNK + 1);
      expect(ct).toBe(SV2_MAX_PLAINTEXT_CHUNK + SV2_MAC_SIZE + 1 + SV2_MAC_SIZE);
    });

    it('plaintext -> ciphertext -> plaintext round-trips', () => {
      const sizes = [0, 1, 100, SV2_MAX_PLAINTEXT_CHUNK, SV2_MAX_PLAINTEXT_CHUNK + 1, SV2_MAX_PLAINTEXT_CHUNK * 2 + 500];
      for (const pt of sizes) {
        const ct = plaintextToCiphertextLength(pt);
        expect(ciphertextToPlaintextLength(ct)).toBe(pt);
      }
    });

    it('should throw for invalid ciphertext length (remainder too small)', () => {
      // A remainder of exactly SV2_MAC_SIZE would mean 0 plaintext bytes but still a chunk
      // Actually that's valid (0 plaintext + 16 MAC). Let's test remainder < MAC
      expect(() => ciphertextToPlaintextLength(5)).toThrow(RangeError);
    });
  });

  // ── Plaintext Frame Reader / Writer ─────────────────────────────────

  describe('plaintext framing', () => {
    it('should write and read a complete plaintext frame', () => {
      const writer = new Sv2FrameWriter(null);
      const header: Sv2FrameHeader = {
        extensionType: 0,
        msgType: 0x00,
        msgLength: 5,
      };
      const payload = Buffer.from('hello');
      const wire = writer.writeFrame(header, payload);

      const reader = new Sv2FrameReader(null);
      const frames = reader.feed(wire);
      expect(frames.length).toBe(1);
      expect(frames[0].header.msgType).toBe(0x00);
      expect(frames[0].payload.toString()).toBe('hello');
    });

    it('should handle fragmented TCP delivery', () => {
      const writer = new Sv2FrameWriter(null);
      const header: Sv2FrameHeader = {
        extensionType: 0,
        msgType: 0x10,
        msgLength: 10,
      };
      const payload = Buffer.alloc(10, 0xab);
      const wire = writer.writeFrame(header, payload);

      const reader = new Sv2FrameReader(null);

      // Feed byte by byte
      let frames: any[] = [];
      for (let i = 0; i < wire.length; i++) {
        const chunk = wire.subarray(i, i + 1);
        frames = frames.concat(reader.feed(Buffer.from(chunk)));
      }

      expect(frames.length).toBe(1);
      expect(frames[0].header.msgType).toBe(0x10);
      expect(frames[0].payload).toEqual(payload);
    });

    it('should parse multiple frames in one feed', () => {
      const writer = new Sv2FrameWriter(null);
      const frames: Buffer[] = [];
      for (let i = 0; i < 3; i++) {
        const header: Sv2FrameHeader = {
          extensionType: 0,
          msgType: i,
          msgLength: 4,
        };
        frames.push(writer.writeFrame(header, Buffer.alloc(4, i)));
      }

      const reader = new Sv2FrameReader(null);
      const result = reader.feed(Buffer.concat(frames));
      expect(result.length).toBe(3);
      for (let i = 0; i < 3; i++) {
        expect(result[i].header.msgType).toBe(i);
        expect(result[i].payload).toEqual(Buffer.alloc(4, i));
      }
    });

    it('should handle zero-length payload', () => {
      const writer = new Sv2FrameWriter(null);
      const header: Sv2FrameHeader = {
        extensionType: 0,
        msgType: 0x01,
        msgLength: 0,
      };
      const wire = writer.writeFrame(header, Buffer.alloc(0));

      const reader = new Sv2FrameReader(null);
      const frames = reader.feed(wire);
      expect(frames.length).toBe(1);
      expect(frames[0].payload.length).toBe(0);
    });
  });

  // ── Encrypted Frame Reader / Writer ─────────────────────────────────

  describe('encrypted framing', () => {
    it('should write and read encrypted frames with mock cipher', () => {
      // Simple XOR "encryption" for testing frame logic
      const xorKey = 0x42;
      const encrypt = (pt: Buffer) => {
        const ct = Buffer.alloc(pt.length + SV2_MAC_SIZE);
        for (let i = 0; i < pt.length; i++) ct[i] = pt[i] ^ xorKey;
        // Fake MAC: zeros
        return ct;
      };
      const decrypt = (ct: Buffer) => {
        const pt = Buffer.alloc(ct.length - SV2_MAC_SIZE);
        for (let i = 0; i < pt.length; i++) pt[i] = ct[i] ^ xorKey;
        return pt;
      };

      const writer = new Sv2FrameWriter(encrypt);
      const header: Sv2FrameHeader = {
        extensionType: 0,
        msgType: 0x10,
        msgLength: 8,
      };
      const payload = Buffer.from('testdata');
      const wire = writer.writeFrame(header, payload);

      const reader = new Sv2FrameReader(decrypt);
      const frames = reader.feed(wire);
      expect(frames.length).toBe(1);
      expect(frames[0].header.msgType).toBe(0x10);
      expect(frames[0].payload.toString()).toBe('testdata');
    });

    it('should switch from plaintext to encrypted mode', () => {
      const encrypt = (pt: Buffer) => Buffer.concat([pt, Buffer.alloc(SV2_MAC_SIZE)]);
      const decrypt = (ct: Buffer) => ct.subarray(0, ct.length - SV2_MAC_SIZE);

      // Start in plaintext mode
      const writer = new Sv2FrameWriter(null);
      const reader = new Sv2FrameReader(null);

      const plainHeader: Sv2FrameHeader = { extensionType: 0, msgType: 0x00, msgLength: 3 };
      const plainWire = writer.writeFrame(plainHeader, Buffer.from('abc'));
      let frames = reader.feed(plainWire);
      expect(frames.length).toBe(1);
      expect(frames[0].payload.toString()).toBe('abc');

      // Switch to encrypted
      writer.setEncryptFn(encrypt);
      reader.setDecryptFn(decrypt);

      const encHeader: Sv2FrameHeader = { extensionType: 0, msgType: 0x01, msgLength: 3 };
      const encWire = writer.writeFrame(encHeader, Buffer.from('xyz'));
      frames = reader.feed(encWire);
      expect(frames.length).toBe(1);
      expect(frames[0].payload.toString()).toBe('xyz');
    });
  });
});
