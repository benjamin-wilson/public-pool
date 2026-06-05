// ── SV2 Noise NX Handshake & Encrypted Transport ────────────────────
// Implements Noise_NX_Secp256k1+EllSwift_ChaChaPoly_SHA256 for SV2.
// Server (responder) side: receives Act 1, sends Act 2, then
// encrypted transport in both directions.

import * as crypto from 'crypto';
import * as ecc from 'tiny-secp256k1';
import {
  SV2_NOISE_PROTOCOL_NAME,
  SV2_NOISE_PROTOCOL_NAME_AESGCM,
  SV2_ELLSWIFT_KEY_SIZE,
  SV2_MAC_SIZE,
  SV2_SIGNATURE_NOISE_MSG_SIZE,
} from './sv2-constants';

// ── Cipher Algorithm Type ───────────────────────────────────────────

export type Sv2CipherAlgorithm = 'chacha20-poly1305' | 'aes-256-gcm';

function getNoiseProtocolName(cipher: Sv2CipherAlgorithm): string {
  return cipher === 'aes-256-gcm'
    ? SV2_NOISE_PROTOCOL_NAME_AESGCM
    : SV2_NOISE_PROTOCOL_NAME;
}

// ── EllSwift Loader (ESM dynamic import) ────────────────────────────

interface EllSwiftApi {
  keygen(): { privateKey: Uint8Array; publicKey: Uint8Array };
  getSharedSecret(privKey: Uint8Array, pubKey: Uint8Array): Uint8Array;
  getSharedSecretBip324(
    privateKeyOurs: Uint8Array,
    publicKeyTheirs: Uint8Array,
    publicKeyOurs: Uint8Array,
    initiating: boolean,
  ): Uint8Array;
}

let ellSwiftCache: EllSwiftApi | null = null;

export async function loadEllSwift(): Promise<EllSwiftApi> {
  if (ellSwiftCache) return ellSwiftCache;
  let mod: any;
  try {
    // Works in Jest (ts-jest transforms ESM to CJS) and bundled environments
    mod = require('@scure/btc-signer/p2p.js');
  } catch {
    // Runtime fallback: dynamic import for ESM-only packages in Node CJS mode
    const importFn = new Function('specifier', 'return import(specifier)');
    mod = await importFn('@scure/btc-signer/p2p.js');
  }
  ellSwiftCache = mod.elligatorSwift as EllSwiftApi;
  return ellSwiftCache;
}

// ── Crypto Primitives ───────────────────────────────────────────────

export function hmacHash(key: Buffer, data: Buffer): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

export function sha256(data: Buffer): Buffer {
  return crypto.createHash('sha256').update(data).digest();
}

/**
 * SV2 HKDF with 2 outputs (not RFC 5869).
 * temp_key = HMAC(chaining_key, input_key_material)
 * output1 = HMAC(temp_key, 0x01)
 * output2 = HMAC(temp_key, output1 || 0x02)
 */
export function hkdf2(chainingKey: Buffer, ikm: Buffer): [Buffer, Buffer] {
  const tempKey = hmacHash(chainingKey, ikm);
  const out1 = hmacHash(tempKey, Buffer.from([0x01]));
  const out2 = hmacHash(tempKey, Buffer.concat([out1, Buffer.from([0x02])]));
  return [out1, out2];
}

// ── CipherState ─────────────────────────────────────────────────────

/**
 * Nonce encoding per Noise spec:
 * - ChaCha20-Poly1305 (Section 12.3): 4 zero bytes + LE64(n)
 * - AES-256-GCM (Section 12.4): 4 zero bytes + BE64(n)
 *
 * Set SV2_NONCE_LE=true to force LE for all ciphers (matches SRI Rust behavior).
 */
function encodeNonce(n: bigint, algorithm: Sv2CipherAlgorithm): Buffer {
  const buf = Buffer.alloc(12);
  if (algorithm === 'aes-256-gcm' && process.env.SV2_NONCE_LE !== 'true') {
    buf.writeBigUInt64BE(n, 4);
  } else {
    buf.writeBigUInt64LE(n, 4);
  }
  return buf;
}

export class Sv2CipherState {
  private k: Buffer | null = null;
  private n = 0n;
  private readonly algorithm: Sv2CipherAlgorithm;

  constructor(algorithm: Sv2CipherAlgorithm = 'chacha20-poly1305') {
    this.algorithm = algorithm;
  }

  get hasKey(): boolean {
    return this.k !== null;
  }

  initializeKey(key: Buffer): void {
    if (key.length !== 32) throw new Error('CipherState key must be 32 bytes');
    this.k = key;
    this.n = 0n;
  }

  encryptWithAd(ad: Buffer, plaintext: Buffer): Buffer {
    if (!this.k) return plaintext;
    const nonce = encodeNonce(this.n, this.algorithm);
    const cipher = crypto.createCipheriv(this.algorithm, this.k, nonce, {
      authTagLength: SV2_MAC_SIZE,
    } as any) as crypto.CipherGCM;
    if (this.algorithm === 'aes-256-gcm') {
      cipher.setAAD(ad, { plaintextLength: plaintext.length } as any);
    } else {
      cipher.setAAD(ad, {} as any);
    }
    const encrypted = cipher.update(plaintext);
    cipher.final();
    const tag = cipher.getAuthTag();
    this.n++;
    return Buffer.concat([encrypted, tag]);
  }

  decryptWithAd(ad: Buffer, ciphertext: Buffer): Buffer {
    if (!this.k) return ciphertext;
    if (ciphertext.length < SV2_MAC_SIZE) {
      throw new Error('Ciphertext too short for MAC');
    }
    const nonce = encodeNonce(this.n, this.algorithm);
    const encData = ciphertext.subarray(0, ciphertext.length - SV2_MAC_SIZE);
    const tag = ciphertext.subarray(ciphertext.length - SV2_MAC_SIZE);
    const decipher = crypto.createDecipheriv(this.algorithm, this.k, nonce, {
      authTagLength: SV2_MAC_SIZE,
    } as any) as crypto.DecipherGCM;
    if (this.algorithm === 'aes-256-gcm') {
      decipher.setAAD(ad, { plaintextLength: encData.length } as any);
    } else {
      decipher.setAAD(ad, {} as any);
    }
    decipher.setAuthTag(tag);
    const decrypted = decipher.update(encData);
    decipher.final();
    this.n++;
    return Buffer.from(decrypted);
  }
}

// ── Certificate / Signature Noise Message ───────────────────────────

export interface Sv2SignatureNoiseMessage {
  version: number; // U16
  validFrom: number; // U32 (unix timestamp)
  notValidAfter: number; // U32 (unix timestamp)
  signature: Buffer; // 64-byte Schnorr signature
}

/**
 * Serialize a SignatureNoiseMessage to 74 bytes.
 */
export function serializeSignatureNoiseMessage(msg: Sv2SignatureNoiseMessage): Buffer {
  const buf = Buffer.alloc(SV2_SIGNATURE_NOISE_MSG_SIZE);
  buf.writeUInt16LE(msg.version, 0);
  buf.writeUInt32LE(msg.validFrom, 2);
  buf.writeUInt32LE(msg.notValidAfter, 6);
  msg.signature.copy(buf, 10);
  return buf;
}

/**
 * Deserialize a 74-byte SignatureNoiseMessage.
 */
export function deserializeSignatureNoiseMessage(buf: Buffer): Sv2SignatureNoiseMessage {
  if (buf.length < SV2_SIGNATURE_NOISE_MSG_SIZE) {
    throw new Error(`SignatureNoiseMessage requires ${SV2_SIGNATURE_NOISE_MSG_SIZE} bytes`);
  }
  return {
    version: buf.readUInt16LE(0),
    validFrom: buf.readUInt32LE(2),
    notValidAfter: buf.readUInt32LE(6),
    signature: Buffer.from(buf.subarray(10, 74)),
  };
}

/**
 * Create a SignatureNoiseMessage that certifies a static key.
 * Signs: version || validFrom || notValidAfter || staticPubKey (x-only, 32 bytes)
 * using the authority's private key (BIP-340 Schnorr).
 */
export function createSignatureNoiseMessage(
  authorityPrivKey: Buffer,
  staticPubKeyXOnly: Buffer,
  validFrom: number,
  notValidAfter: number,
): Sv2SignatureNoiseMessage {
  const version = 0;
  const msgBuf = Buffer.alloc(2 + 4 + 4 + 32);
  msgBuf.writeUInt16LE(version, 0);
  msgBuf.writeUInt32LE(validFrom, 2);
  msgBuf.writeUInt32LE(notValidAfter, 6);
  staticPubKeyXOnly.copy(msgBuf, 10);

  const msgHash = sha256(msgBuf);
  const sig = ecc.signSchnorr(msgHash, authorityPrivKey);
  if (!sig) throw new Error('Schnorr signing failed');

  return {
    version,
    validFrom,
    notValidAfter,
    signature: Buffer.from(sig),
  };
}

/**
 * Validate a SignatureNoiseMessage against an authority public key.
 */
export function validateSignatureNoiseMessage(
  msg: Sv2SignatureNoiseMessage,
  authorityPubKeyXOnly: Buffer,
  staticPubKeyXOnly: Buffer,
): boolean {
  const msgBuf = Buffer.alloc(2 + 4 + 4 + 32);
  msgBuf.writeUInt16LE(msg.version, 0);
  msgBuf.writeUInt32LE(msg.validFrom, 2);
  msgBuf.writeUInt32LE(msg.notValidAfter, 6);
  staticPubKeyXOnly.copy(msgBuf, 10);

  const msgHash = sha256(msgBuf);
  return ecc.verifySchnorr(msgHash, authorityPubKeyXOnly, msg.signature);
}

// ── Server Keypair Generation ───────────────────────────────────────

export interface Sv2ServerKeypair {
  privateKey: Buffer; // 32-byte secret scalar
  publicKey: Buffer; // 64-byte EllSwift-encoded public key
}

export async function generateServerKeypair(): Promise<Sv2ServerKeypair> {
  const es = await loadEllSwift();
  const kp = es.keygen();
  return {
    privateKey: Buffer.from(kp.privateKey),
    publicKey: Buffer.from(kp.publicKey),
  };
}

/**
 * Get the x-only (32-byte) public key from a 32-byte private key.
 */
export function xOnlyPubKeyFromPriv(privKey: Buffer): Buffer {
  const xOnly = ecc.xOnlyPointFromScalar(privKey);
  if (!xOnly) throw new Error('Failed to derive x-only public key');
  return Buffer.from(xOnly);
}

// ── Noise NX Session (Responder / Server side) ──────────────────────

export interface Sv2NoiseConfig {
  /** Server's static keypair (EllSwift). */
  staticKeypair: Sv2ServerKeypair;
  /** Pre-computed certificate message (signed by authority). */
  certificateMessage: Sv2SignatureNoiseMessage;
}

export class Sv2NoiseSession {
  private h: Buffer; // handshake hash
  private ck: Buffer; // chaining key
  private tempCipher: Sv2CipherState;
  private sendCipher: Sv2CipherState;
  private recvCipher: Sv2CipherState;
  private handshakeComplete = false;
  private ellSwift!: EllSwiftApi;
  private readonly cipherAlgorithm: Sv2CipherAlgorithm;

  private serverEphemeralPriv!: Buffer;
  private serverEphemeralPub!: Buffer;

  constructor(
    private readonly config: Sv2NoiseConfig,
    cipherAlgorithm: Sv2CipherAlgorithm = 'chacha20-poly1305',
    prologue: Buffer = Buffer.alloc(0),
  ) {
    this.cipherAlgorithm = cipherAlgorithm;

    const protocolNameStr = getNoiseProtocolName(cipherAlgorithm);

    this.tempCipher = new Sv2CipherState(cipherAlgorithm);
    this.sendCipher = new Sv2CipherState(cipherAlgorithm);
    this.recvCipher = new Sv2CipherState(cipherAlgorithm);

    // Initialize h = HASH(protocol_name) if len > 32, else pad
    const protocolName = Buffer.from(protocolNameStr, 'ascii');
    if (protocolName.length <= 32) {
      this.h = Buffer.alloc(32);
      protocolName.copy(this.h);
    } else {
      this.h = sha256(protocolName);
    }
    // ck = h
    this.ck = Buffer.from(this.h);
    // MixHash(prologue) per Noise spec: h = HASH(h || prologue)
    this.h = sha256(Buffer.concat([this.h, prologue]));
  }

  // ── Noise Symmetric State Helpers ─────────────────────────────────

  private mixHash(data: Buffer): void {
    this.h = sha256(Buffer.concat([this.h, data]));
  }

  private mixKey(ikm: Buffer): void {
    const [newCk, tempK] = hkdf2(this.ck, ikm);
    this.ck = newCk;
    this.tempCipher = new Sv2CipherState(this.cipherAlgorithm);
    this.tempCipher.initializeKey(tempK);
  }

  private encryptAndHash(plaintext: Buffer): Buffer {
    const ciphertext = this.tempCipher.encryptWithAd(this.h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  private decryptAndHash(ciphertext: Buffer): Buffer {
    const plaintext = this.tempCipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  // ── ECDH via EllSwift ─────────────────────────────────────────────

  /**
   * Compute BIP-324 EllSwift ECDH.
   * @param localPriv - Our private key (32 bytes)
   * @param localPub - Our EllSwift public key (64 bytes)
   * @param remotePub - Their EllSwift public key (64 bytes)
   * @param weAreInitiator - Party bit: true for initiator, false for responder
   */
  private ecdh(localPriv: Buffer, localPub: Buffer, remotePub: Buffer, weAreInitiator: boolean): Buffer {
    const secret = this.ellSwift.getSharedSecretBip324(
      new Uint8Array(localPriv),
      new Uint8Array(remotePub),
      new Uint8Array(localPub),
      weAreInitiator,
    );
    return Buffer.from(secret);
  }

  // ── Handshake: Process Act 1, Generate Act 2 ─────────────────────

  /**
   * Process the initiator's Act 1 ephemeral key and produce Act 2.
   * EllSwift mode: 64-byte Act 1 -> 234-byte Act 2
   */
  async processAct1(act1: Buffer): Promise<Buffer> {
    if (act1.length !== SV2_ELLSWIFT_KEY_SIZE) {
      throw new Error(`Act 1 must be ${SV2_ELLSWIFT_KEY_SIZE} bytes, got ${act1.length}`);
    }

    const debug = process.env.SV2_NOISE_DEBUG === 'true';

    if (debug) {
      const protocolNameStr = getNoiseProtocolName(this.cipherAlgorithm);
      console.log(`[NOISE] Protocol name: "${protocolNameStr}" (${protocolNameStr.length} bytes)`);
      console.log(`[NOISE] Cipher: ${this.cipherAlgorithm}`);
      console.log(`[NOISE] Init ck=${this.ck.toString('hex')}`);
      console.log(`[NOISE] Init h=${this.h.toString('hex')}`);
    }

    this.ellSwift = await loadEllSwift();

    const remoteEphemeral = act1;
    this.mixHash(remoteEphemeral);
    if (debug) console.log(`[NOISE] After MixHash(re): h=${this.h.toString('hex')}`);

    this.decryptAndHash(Buffer.alloc(0));
    if (debug) console.log(`[NOISE] After DecryptAndHash(empty): h=${this.h.toString('hex')}`);

    const serverEph = this.ellSwift.keygen();
    this.serverEphemeralPriv = Buffer.from(serverEph.privateKey);
    this.serverEphemeralPub = Buffer.from(serverEph.publicKey);

    if (debug) console.log(`[NOISE] Server eph pub: ${this.serverEphemeralPub.toString('hex')}`);

    this.mixHash(this.serverEphemeralPub);
    if (debug) console.log(`[NOISE] After MixHash(se): h=${this.h.toString('hex')}`);

    const eeDH = this.ecdh(
      this.serverEphemeralPriv,
      this.serverEphemeralPub,
      remoteEphemeral,
      false,
    );
    if (debug) console.log(`[NOISE] ee DH shared secret: ${eeDH.toString('hex')}`);

    this.mixKey(eeDH);
    if (debug) console.log(`[NOISE] After MixKey(ee): ck=${this.ck.toString('hex')}`);

    const staticPubKey = this.config.staticKeypair.publicKey;
    if (debug) {
      console.log(`[NOISE] h (AD for encrypt static): ${this.h.toString('hex')}`);
      console.log(`[NOISE] Static pub (plaintext): ${staticPubKey.toString('hex')}`);
    }

    const encryptedStatic = this.encryptAndHash(staticPubKey);
    if (debug) console.log(`[NOISE] Encrypted static (${encryptedStatic.length} bytes): ${encryptedStatic.toString('hex')}`);

    const esDH = this.ecdh(
      this.config.staticKeypair.privateKey,
      this.config.staticKeypair.publicKey,
      remoteEphemeral,
      false,
    );
    if (debug) console.log(`[NOISE] es DH shared secret: ${esDH.toString('hex')}`);

    this.mixKey(esDH);
    if (debug) console.log(`[NOISE] After MixKey(es): ck=${this.ck.toString('hex')}`);

    const certPayload = serializeSignatureNoiseMessage(this.config.certificateMessage);
    if (debug) console.log(`[NOISE] h (AD for encrypt cert): ${this.h.toString('hex')}`);
    if (debug) console.log(`[NOISE] Cert payload (${certPayload.length} bytes): ${certPayload.toString('hex')}`);

    const encryptedCert = this.encryptAndHash(certPayload);
    if (debug) console.log(`[NOISE] Encrypted cert (${encryptedCert.length} bytes)`);

    const [k1, k2] = hkdf2(this.ck, Buffer.alloc(0));
    this.recvCipher.initializeKey(k1);
    this.sendCipher.initializeKey(k2);
    this.handshakeComplete = true;

    const act2 = Buffer.concat([this.serverEphemeralPub, encryptedStatic, encryptedCert]);
    if (debug) console.log(`[NOISE] Act 2 total: ${act2.length} bytes`);

    return act2;
  }

  // ── Post-Handshake Transport ──────────────────────────────────────

  encrypt(plaintext: Buffer): Buffer {
    if (!this.handshakeComplete) throw new Error('Handshake not complete');
    return this.sendCipher.encryptWithAd(Buffer.alloc(0), plaintext);
  }

  decrypt(ciphertext: Buffer): Buffer {
    if (!this.handshakeComplete) throw new Error('Handshake not complete');
    return this.recvCipher.decryptWithAd(Buffer.alloc(0), ciphertext);
  }

  get isHandshakeComplete(): boolean {
    return this.handshakeComplete;
  }
}

// ── Initiator Session (for testing) ─────────────────────────────────

export class Sv2NoiseInitiator {
  private h: Buffer;
  private ck: Buffer;
  private tempCipher: Sv2CipherState;
  private sendCipher: Sv2CipherState;
  private recvCipher: Sv2CipherState;
  private handshakeComplete = false;
  private ellSwift!: EllSwiftApi;
  private readonly cipherAlgorithm: Sv2CipherAlgorithm;

  private ephemeralPriv!: Buffer;
  private ephemeralPub!: Buffer;

  constructor(
    cipherAlgorithm: Sv2CipherAlgorithm = 'chacha20-poly1305',
    prologue: Buffer = Buffer.alloc(0),
  ) {
    this.cipherAlgorithm = cipherAlgorithm;

    const protocolNameStr = getNoiseProtocolName(cipherAlgorithm);

    this.tempCipher = new Sv2CipherState(cipherAlgorithm);
    this.sendCipher = new Sv2CipherState(cipherAlgorithm);
    this.recvCipher = new Sv2CipherState(cipherAlgorithm);

    const protocolName = Buffer.from(protocolNameStr, 'ascii');
    if (protocolName.length <= 32) {
      this.h = Buffer.alloc(32);
      protocolName.copy(this.h);
    } else {
      this.h = sha256(protocolName);
    }
    this.ck = Buffer.from(this.h);
    // MixHash(prologue) per Noise spec: h = HASH(h || prologue)
    this.h = sha256(Buffer.concat([this.h, prologue]));
  }

  private mixHash(data: Buffer): void {
    this.h = sha256(Buffer.concat([this.h, data]));
  }

  private mixKey(ikm: Buffer): void {
    const [newCk, tempK] = hkdf2(this.ck, ikm);
    this.ck = newCk;
    this.tempCipher = new Sv2CipherState(this.cipherAlgorithm);
    this.tempCipher.initializeKey(tempK);
  }

  private decryptAndHash(ciphertext: Buffer): Buffer {
    const plaintext = this.tempCipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  private ecdh(localPriv: Buffer, localPub: Buffer, remotePub: Buffer, weAreInitiator: boolean): Buffer {
    const secret = this.ellSwift.getSharedSecretBip324(
      new Uint8Array(localPriv),
      new Uint8Array(remotePub),
      new Uint8Array(localPub),
      weAreInitiator,
    );
    return Buffer.from(secret);
  }

  /** Generate Act 1: 64-byte EllSwift ephemeral key. */
  async generateAct1(): Promise<Buffer> {
    this.ellSwift = await loadEllSwift();
    const kp = this.ellSwift.keygen();
    this.ephemeralPriv = Buffer.from(kp.privateKey);
    this.ephemeralPub = Buffer.from(kp.publicKey);

    this.mixHash(this.ephemeralPub);
    this.mixHash(Buffer.alloc(0));
    return this.ephemeralPub;
  }

  /** Process Act 2 from responder, returns the decrypted server static key and cert. */
  processAct2(act2: Buffer): {
    serverStaticKey: Buffer;
    certificate: Sv2SignatureNoiseMessage;
  } {
    if (act2.length !== 234) {
      throw new Error(`Act 2 must be 234 bytes, got ${act2.length}`);
    }

    const serverEphemeral = act2.subarray(0, 64);
    const encryptedStatic = act2.subarray(64, 144);
    const encryptedCert = act2.subarray(144, 234);

    this.mixHash(Buffer.from(serverEphemeral));

    const eeDH = this.ecdh(
      this.ephemeralPriv,
      this.ephemeralPub,
      Buffer.from(serverEphemeral),
      true,
    );
    this.mixKey(eeDH);

    const serverStaticKey = this.decryptAndHash(Buffer.from(encryptedStatic));

    const esDH = this.ecdh(
      this.ephemeralPriv,
      this.ephemeralPub,
      serverStaticKey,
      true,
    );
    this.mixKey(esDH);

    const certPayload = this.decryptAndHash(Buffer.from(encryptedCert));
    const certificate = deserializeSignatureNoiseMessage(certPayload);

    const [k1, k2] = hkdf2(this.ck, Buffer.alloc(0));
    this.sendCipher.initializeKey(k1);
    this.recvCipher.initializeKey(k2);
    this.handshakeComplete = true;

    return { serverStaticKey, certificate };
  }

  encrypt(plaintext: Buffer): Buffer {
    if (!this.handshakeComplete) throw new Error('Handshake not complete');
    return this.sendCipher.encryptWithAd(Buffer.alloc(0), plaintext);
  }

  decrypt(ciphertext: Buffer): Buffer {
    if (!this.handshakeComplete) throw new Error('Handshake not complete');
    return this.recvCipher.decryptWithAd(Buffer.alloc(0), ciphertext);
  }

  get isHandshakeComplete(): boolean {
    return this.handshakeComplete;
  }
}
