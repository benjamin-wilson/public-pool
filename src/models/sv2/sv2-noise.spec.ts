import * as crypto from 'crypto';
import {
  hmacHash,
  sha256,
  hkdf2,
  Sv2CipherState,
  Sv2CipherAlgorithm,
  Sv2NoiseSession,
  Sv2NoiseInitiator,
  generateServerKeypair,
  xOnlyPubKeyFromPriv,
  createSignatureNoiseMessage,
  validateSignatureNoiseMessage,
  serializeSignatureNoiseMessage,
  deserializeSignatureNoiseMessage,
  loadEllSwift,
} from './sv2-noise';
import { SV2_MAC_SIZE } from './sv2-constants';

describe('SV2 Noise', () => {
  // ── HMAC-SHA256 Test Vectors ──────────────────────────────────────

  describe('HMAC-SHA256', () => {
    it('should match known test vector (RFC 4231 test 1)', () => {
      const key = Buffer.from('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b', 'hex');
      const data = Buffer.from('Hi There');
      const expected = 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7';
      expect(hmacHash(key, data).toString('hex')).toBe(expected);
    });

    it('should match known test vector (RFC 4231 test 2)', () => {
      const key = Buffer.from('Jefe');
      const data = Buffer.from('what do ya want for nothing?');
      const expected = '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843';
      expect(hmacHash(key, data).toString('hex')).toBe(expected);
    });
  });

  // ── HKDF2 ─────────────────────────────────────────────────────────

  describe('HKDF2', () => {
    it('should produce two 32-byte outputs', () => {
      const ck = Buffer.alloc(32, 0x01);
      const ikm = Buffer.alloc(32, 0x02);
      const [out1, out2] = hkdf2(ck, ikm);
      expect(out1.length).toBe(32);
      expect(out2.length).toBe(32);
      expect(out1.equals(out2)).toBe(false);
    });

    it('should be deterministic', () => {
      const ck = crypto.randomBytes(32);
      const ikm = crypto.randomBytes(32);
      const [a1, a2] = hkdf2(ck, ikm);
      const [b1, b2] = hkdf2(ck, ikm);
      expect(a1.equals(b1)).toBe(true);
      expect(a2.equals(b2)).toBe(true);
    });

    it('should work with empty IKM', () => {
      const ck = Buffer.alloc(32, 0xaa);
      const [out1, out2] = hkdf2(ck, Buffer.alloc(0));
      expect(out1.length).toBe(32);
      expect(out2.length).toBe(32);
    });
  });

  // ── CipherState ───────────────────────────────────────────────────

  describe('CipherState', () => {
    it('should encrypt and decrypt with matching keys', () => {
      const key = crypto.randomBytes(32);
      const enc = new Sv2CipherState();
      const dec = new Sv2CipherState();
      enc.initializeKey(key);
      dec.initializeKey(key);

      const ad = Buffer.alloc(0);
      const plaintext = Buffer.from('test message for cipher state');
      const ciphertext = enc.encryptWithAd(ad, plaintext);

      expect(ciphertext.length).toBe(plaintext.length + SV2_MAC_SIZE);
      expect(ciphertext.subarray(0, plaintext.length).equals(plaintext)).toBe(false);

      const decrypted = dec.decryptWithAd(ad, ciphertext);
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('should fail decryption with wrong key', () => {
      const enc = new Sv2CipherState();
      const dec = new Sv2CipherState();
      enc.initializeKey(crypto.randomBytes(32));
      dec.initializeKey(crypto.randomBytes(32));

      const ct = enc.encryptWithAd(Buffer.alloc(0), Buffer.from('secret'));
      expect(() => dec.decryptWithAd(Buffer.alloc(0), ct)).toThrow();
    });

    it('should fail decryption with wrong AD', () => {
      const key = crypto.randomBytes(32);
      const enc = new Sv2CipherState();
      const dec = new Sv2CipherState();
      enc.initializeKey(key);
      dec.initializeKey(key);

      const ct = enc.encryptWithAd(Buffer.from('ad1'), Buffer.from('data'));
      expect(() => dec.decryptWithAd(Buffer.from('ad2'), ct)).toThrow();
    });

    it('should increment nonce (different ciphertext for same plaintext)', () => {
      const key = crypto.randomBytes(32);
      const enc = new Sv2CipherState();
      enc.initializeKey(key);

      const ad = Buffer.alloc(0);
      const pt = Buffer.from('same');
      const ct1 = enc.encryptWithAd(ad, pt);
      const ct2 = enc.encryptWithAd(ad, pt);
      expect(ct1.equals(ct2)).toBe(false);
    });

    it('should pass through plaintext when key is not set', () => {
      const cs = new Sv2CipherState();
      const ad = Buffer.alloc(0);
      const pt = Buffer.from('hello');
      expect(cs.encryptWithAd(ad, pt).equals(pt)).toBe(true);
      expect(cs.decryptWithAd(ad, pt).equals(pt)).toBe(true);
    });

    it('should track hasKey', () => {
      const cs = new Sv2CipherState();
      expect(cs.hasKey).toBe(false);
      cs.initializeKey(crypto.randomBytes(32));
      expect(cs.hasKey).toBe(true);
    });

    it('should reject non-32-byte keys', () => {
      const cs = new Sv2CipherState();
      expect(() => cs.initializeKey(Buffer.alloc(16))).toThrow();
    });

    it('should reject ciphertext shorter than MAC', () => {
      const cs = new Sv2CipherState();
      cs.initializeKey(crypto.randomBytes(32));
      expect(() => cs.decryptWithAd(Buffer.alloc(0), Buffer.alloc(10))).toThrow();
    });

    it('should handle multiple sequential encryptions and decryptions', () => {
      const key = crypto.randomBytes(32);
      const enc = new Sv2CipherState();
      const dec = new Sv2CipherState();
      enc.initializeKey(key);
      dec.initializeKey(key);

      const ad = Buffer.alloc(0);
      for (let i = 0; i < 10; i++) {
        const pt = Buffer.from(`message ${i}`);
        const ct = enc.encryptWithAd(ad, pt);
        const result = dec.decryptWithAd(ad, ct);
        expect(result.toString()).toBe(`message ${i}`);
      }
    });
  });

  // ── Certificate / Signature ───────────────────────────────────────

  describe('Certificate', () => {
    it('should create and validate a signature noise message', () => {
      const authorityPrivKey = crypto.randomBytes(32);
      const authorityPubKey = xOnlyPubKeyFromPriv(authorityPrivKey);
      const staticPubKeyXOnly = crypto.randomBytes(32);

      const now = Math.floor(Date.now() / 1000);
      const cert = createSignatureNoiseMessage(
        authorityPrivKey,
        staticPubKeyXOnly,
        now - 3600,
        now + 86400,
      );

      expect(cert.version).toBe(0);
      expect(cert.signature.length).toBe(64);
      expect(validateSignatureNoiseMessage(cert, authorityPubKey, staticPubKeyXOnly)).toBe(true);
    });

    it('should fail validation with wrong authority key', () => {
      const authorityPrivKey = crypto.randomBytes(32);
      const wrongPubKey = xOnlyPubKeyFromPriv(crypto.randomBytes(32));
      const staticPubKeyXOnly = crypto.randomBytes(32);

      const now = Math.floor(Date.now() / 1000);
      const cert = createSignatureNoiseMessage(authorityPrivKey, staticPubKeyXOnly, now, now + 86400);

      expect(validateSignatureNoiseMessage(cert, wrongPubKey, staticPubKeyXOnly)).toBe(false);
    });

    it('should serialize and deserialize signature noise message', () => {
      const msg = {
        version: 0,
        validFrom: 1700000000,
        notValidAfter: 1700086400,
        signature: crypto.randomBytes(64),
      };
      const buf = serializeSignatureNoiseMessage(msg);
      expect(buf.length).toBe(74);
      const result = deserializeSignatureNoiseMessage(buf);
      expect(result.version).toBe(msg.version);
      expect(result.validFrom).toBe(msg.validFrom);
      expect(result.notValidAfter).toBe(msg.notValidAfter);
      expect(result.signature.equals(msg.signature)).toBe(true);
    });
  });

  // ── Key Generation ────────────────────────────────────────────────

  describe('Key Generation', () => {
    it('should generate server keypair with correct sizes', async () => {
      const kp = await generateServerKeypair();
      expect(kp.privateKey.length).toBe(32);
      expect(kp.publicKey.length).toBe(64);
    });

    it('should produce unique keypairs', async () => {
      const kp1 = await generateServerKeypair();
      const kp2 = await generateServerKeypair();
      expect(kp1.privateKey.equals(kp2.privateKey)).toBe(false);
    });

    it('should derive x-only pubkey from privkey', () => {
      const privKey = crypto.randomBytes(32);
      const xOnly = xOnlyPubKeyFromPriv(privKey);
      expect(xOnly.length).toBe(32);
    });
  });

  // ── EllSwift Loader ───────────────────────────────────────────────

  describe('EllSwift Loader', () => {
    it('should load EllSwift API', async () => {
      const es = await loadEllSwift();
      expect(typeof es.keygen).toBe('function');
      expect(typeof es.getSharedSecret).toBe('function');
    });

    it('should cache the loaded module', async () => {
      const es1 = await loadEllSwift();
      const es2 = await loadEllSwift();
      expect(es1).toBe(es2);
    });
  });

  // ── Full Noise NX Handshake Self-Test ─────────────────────────────

  describe('Full Handshake', () => {
    it('should complete NX handshake and exchange encrypted messages', async () => {
      // 1. Generate server config
      const serverKeypair = await generateServerKeypair();
      const authorityPrivKey = crypto.randomBytes(32);
      const authorityPubKey = xOnlyPubKeyFromPriv(authorityPrivKey);
      const staticXOnly = xOnlyPubKeyFromPriv(serverKeypair.privateKey);

      const now = Math.floor(Date.now() / 1000);
      const cert = createSignatureNoiseMessage(
        authorityPrivKey,
        staticXOnly,
        now - 3600,
        now + 86400,
      );

      // 2. Create sessions
      const responder = new Sv2NoiseSession({
        staticKeypair: serverKeypair,
        certificateMessage: cert,
      });
      const initiator = new Sv2NoiseInitiator();

      // 3. Act 1: Initiator -> Responder (64 bytes)
      const act1 = await initiator.generateAct1();
      expect(act1.length).toBe(64);

      // 4. Act 2: Responder -> Initiator (234 bytes)
      const act2 = await responder.processAct1(act1);
      expect(act2.length).toBe(234);

      // 5. Initiator processes Act 2
      const { serverStaticKey, certificate } = initiator.processAct2(act2);
      expect(serverStaticKey.length).toBe(64);
      expect(certificate.version).toBe(0);

      // 6. Validate certificate
      expect(
        validateSignatureNoiseMessage(certificate, authorityPubKey, staticXOnly),
      ).toBe(true);

      // 7. Both sides should be ready
      expect(responder.isHandshakeComplete).toBe(true);
      expect(initiator.isHandshakeComplete).toBe(true);

      // 8. Exchange encrypted messages: initiator -> responder
      const msg1 = Buffer.from('hello from initiator');
      const enc1 = initiator.encrypt(msg1);
      expect(enc1.length).toBe(msg1.length + SV2_MAC_SIZE);
      const dec1 = responder.decrypt(enc1);
      expect(dec1.toString()).toBe('hello from initiator');

      // 9. Exchange encrypted messages: responder -> initiator
      const msg2 = Buffer.from('hello from responder');
      const enc2 = responder.encrypt(msg2);
      const dec2 = initiator.decrypt(enc2);
      expect(dec2.toString()).toBe('hello from responder');

      // 10. Multiple messages with nonce increment
      for (let i = 0; i < 5; i++) {
        const pt = Buffer.from(`bidirectional msg ${i}`);
        const ct = responder.encrypt(pt);
        expect(initiator.decrypt(ct).toString()).toBe(`bidirectional msg ${i}`);

        const pt2 = Buffer.from(`reply ${i}`);
        const ct2 = initiator.encrypt(pt2);
        expect(responder.decrypt(ct2).toString()).toBe(`reply ${i}`);
      }
    });

    it('should fail handshake with wrong Act 1 size', async () => {
      const serverKeypair = await generateServerKeypair();
      const authorityPrivKey = crypto.randomBytes(32);
      const staticXOnly = xOnlyPubKeyFromPriv(serverKeypair.privateKey);
      const now = Math.floor(Date.now() / 1000);
      const cert = createSignatureNoiseMessage(authorityPrivKey, staticXOnly, now, now + 86400);

      const responder = new Sv2NoiseSession({
        staticKeypair: serverKeypair,
        certificateMessage: cert,
      });

      await expect(responder.processAct1(Buffer.alloc(32))).rejects.toThrow();
    });

    it('should not encrypt before handshake is complete', () => {
      const session = new Sv2NoiseInitiator();
      expect(() => session.encrypt(Buffer.from('test'))).toThrow('Handshake not complete');
      expect(() => session.decrypt(Buffer.alloc(32))).toThrow('Handshake not complete');
    });

    it('should complete NX handshake with AES-256-GCM and exchange encrypted messages', async () => {
      // 1. Generate server config
      const serverKeypair = await generateServerKeypair();
      const authorityPrivKey = crypto.randomBytes(32);
      const authorityPubKey = xOnlyPubKeyFromPriv(authorityPrivKey);
      const staticXOnly = xOnlyPubKeyFromPriv(serverKeypair.privateKey);

      const now = Math.floor(Date.now() / 1000);
      const cert = createSignatureNoiseMessage(
        authorityPrivKey,
        staticXOnly,
        now - 3600,
        now + 86400,
      );

      const cipher: Sv2CipherAlgorithm = 'aes-256-gcm';

      // 2. Create sessions with AES-GCM
      const responder = new Sv2NoiseSession(
        { staticKeypair: serverKeypair, certificateMessage: cert },
        cipher,
      );
      const initiator = new Sv2NoiseInitiator(cipher);

      // 3. Act 1: Initiator -> Responder (64 bytes)
      const act1 = await initiator.generateAct1();
      expect(act1.length).toBe(64);

      // 4. Act 2: Responder -> Initiator (234 bytes)
      const act2 = await responder.processAct1(act1);
      expect(act2.length).toBe(234);

      // 5. Initiator processes Act 2
      const { serverStaticKey, certificate } = initiator.processAct2(act2);
      expect(serverStaticKey.length).toBe(64);
      expect(certificate.version).toBe(0);

      // 6. Validate certificate
      expect(
        validateSignatureNoiseMessage(certificate, authorityPubKey, staticXOnly),
      ).toBe(true);

      // 7. Both sides should be ready
      expect(responder.isHandshakeComplete).toBe(true);
      expect(initiator.isHandshakeComplete).toBe(true);

      // 8. Exchange encrypted messages: initiator -> responder
      const msg1 = Buffer.from('hello from AES-GCM initiator');
      const enc1 = initiator.encrypt(msg1);
      expect(enc1.length).toBe(msg1.length + SV2_MAC_SIZE);
      const dec1 = responder.decrypt(enc1);
      expect(dec1.toString()).toBe('hello from AES-GCM initiator');

      // 9. Exchange encrypted messages: responder -> initiator
      const msg2 = Buffer.from('hello from AES-GCM responder');
      const enc2 = responder.encrypt(msg2);
      const dec2 = initiator.decrypt(enc2);
      expect(dec2.toString()).toBe('hello from AES-GCM responder');

      // 10. Multiple messages with nonce increment
      for (let i = 0; i < 5; i++) {
        const pt = Buffer.from(`AES-GCM bidirectional msg ${i}`);
        const ct = responder.encrypt(pt);
        expect(initiator.decrypt(ct).toString()).toBe(`AES-GCM bidirectional msg ${i}`);

        const pt2 = Buffer.from(`AES-GCM reply ${i}`);
        const ct2 = initiator.encrypt(pt2);
        expect(responder.decrypt(ct2).toString()).toBe(`AES-GCM reply ${i}`);
      }
    });

    it('should not cross-decrypt between ChaCha20 and AES-GCM sessions', async () => {
      const serverKeypair = await generateServerKeypair();
      const authorityPrivKey = crypto.randomBytes(32);
      const staticXOnly = xOnlyPubKeyFromPriv(serverKeypair.privateKey);
      const now = Math.floor(Date.now() / 1000);
      const cert = createSignatureNoiseMessage(authorityPrivKey, staticXOnly, now, now + 86400);

      // ChaCha session
      const chachaResp = new Sv2NoiseSession(
        { staticKeypair: serverKeypair, certificateMessage: cert },
      );
      const chachaInit = new Sv2NoiseInitiator();
      const chachaAct1 = await chachaInit.generateAct1();
      const chachaAct2 = await chachaResp.processAct1(chachaAct1);
      chachaInit.processAct2(chachaAct2);

      // AES-GCM session (different keys, so ciphertexts are incompatible)
      const serverKeypair2 = await generateServerKeypair();
      const staticXOnly2 = xOnlyPubKeyFromPriv(serverKeypair2.privateKey);
      const cert2 = createSignatureNoiseMessage(authorityPrivKey, staticXOnly2, now, now + 86400);
      const aesResp = new Sv2NoiseSession(
        { staticKeypair: serverKeypair2, certificateMessage: cert2 },
        'aes-256-gcm',
      );
      const aesInit = new Sv2NoiseInitiator('aes-256-gcm');
      const aesAct1 = await aesInit.generateAct1();
      const aesAct2 = await aesResp.processAct1(aesAct1);
      aesInit.processAct2(aesAct2);

      // Encrypt with ChaCha, try to decrypt with AES-GCM -> should fail
      const ct = chachaInit.encrypt(Buffer.from('test'));
      expect(() => aesResp.decrypt(ct)).toThrow();
    });
  });

  // ── AES-GCM CipherState ─────────────────────────────────────────────

  describe('CipherState AES-256-GCM', () => {
    it('should encrypt and decrypt with AES-256-GCM', () => {
      const key = crypto.randomBytes(32);
      const enc = new Sv2CipherState('aes-256-gcm');
      const dec = new Sv2CipherState('aes-256-gcm');
      enc.initializeKey(key);
      dec.initializeKey(key);

      const ad = Buffer.alloc(0);
      const plaintext = Buffer.from('test message for AES-GCM cipher state');
      const ciphertext = enc.encryptWithAd(ad, plaintext);

      expect(ciphertext.length).toBe(plaintext.length + SV2_MAC_SIZE);
      const decrypted = dec.decryptWithAd(ad, ciphertext);
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('should handle multiple sequential encryptions with AES-256-GCM', () => {
      const key = crypto.randomBytes(32);
      const enc = new Sv2CipherState('aes-256-gcm');
      const dec = new Sv2CipherState('aes-256-gcm');
      enc.initializeKey(key);
      dec.initializeKey(key);

      const ad = Buffer.alloc(0);
      for (let i = 0; i < 10; i++) {
        const pt = Buffer.from(`AES-GCM message ${i}`);
        const ct = enc.encryptWithAd(ad, pt);
        const result = dec.decryptWithAd(ad, ct);
        expect(result.toString()).toBe(`AES-GCM message ${i}`);
      }
    });

    it('should encrypt and decrypt with non-empty AD using AES-256-GCM', () => {
      const key = crypto.randomBytes(32);
      const enc = new Sv2CipherState('aes-256-gcm');
      const dec = new Sv2CipherState('aes-256-gcm');
      enc.initializeKey(key);
      dec.initializeKey(key);

      const ad = Buffer.from('additional data');
      const plaintext = Buffer.from('secret payload');
      const ciphertext = enc.encryptWithAd(ad, plaintext);
      const decrypted = dec.decryptWithAd(ad, ciphertext);
      expect(decrypted.equals(plaintext)).toBe(true);
    });
  });
});
