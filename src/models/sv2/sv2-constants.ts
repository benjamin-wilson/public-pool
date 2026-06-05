// ── SV2 Protocol Constants ──────────────────────────────────────────

/** Standard (unencrypted) frame header: 2-byte ext+type + 3-byte length + 1-byte channel bit = 6 */
export const SV2_HEADER_SIZE = 6;

/** Poly1305 MAC appended to every AEAD ciphertext block */
export const SV2_MAC_SIZE = 16;

/** Encrypted frame header size: SV2_HEADER_SIZE + SV2_MAC_SIZE = 22 */
export const SV2_ENCRYPTED_HEADER_SIZE = SV2_HEADER_SIZE + SV2_MAC_SIZE;

/** Max plaintext bytes in a single AEAD chunk (2^16 - 1 - MAC) */
export const SV2_MAX_PLAINTEXT_CHUNK = 65519;

/** Max ciphertext bytes in a single AEAD chunk (2^16 - 1) */
export const SV2_MAX_CIPHERTEXT_CHUNK = 65535;

/** EllSwift-encoded public key size (64 bytes) */
export const SV2_ELLSWIFT_KEY_SIZE = 64;

/** Bit flag in extension_type indicating a channel message */
export const SV2_CHANNEL_MSG_FLAG = 0x8000;

/** Protocol identifier string used in SetupConnection */
export const SV2_PROTOCOL_NAME = 'MiningProtocol';

// ── Noise NX Handshake Constants ────────────────────────────────────

/** Noise NX protocol name used to initialize h (ChaCha20-Poly1305) */
export const SV2_NOISE_PROTOCOL_NAME = 'Noise_NX_Secp256k1+EllSwift_ChaChaPoly_SHA256';

/** Noise NX protocol name for AES-256-GCM cipher */
export const SV2_NOISE_PROTOCOL_NAME_AESGCM = 'Noise_NX_Secp256k1+EllSwift_AESGCM_SHA256';

/** Noise NX Act 1 size: 64-byte initiator ephemeral EllSwift key */
export const SV2_NOISE_ACT1_SIZE = 64;

/** Noise NX Act 2 size: 64 (server ephemeral) + 80 (encrypted static) + 90 (encrypted cert) = 234 */
export const SV2_NOISE_ACT2_SIZE = 234;

/** SIGNATURE_NOISE_MESSAGE payload size (without MAC): version(2) + validFrom(4) + notValidAfter(4) + signature(64) = 74 */
export const SV2_SIGNATURE_NOISE_MSG_SIZE = 74;

// ── Message Type Enum ───────────────────────────────────────────────

export enum Sv2MsgType {
  // Common messages
  SETUP_CONNECTION = 0x00,
  SETUP_CONNECTION_SUCCESS = 0x01,
  SETUP_CONNECTION_ERROR = 0x02,
  CHANNEL_ENDPOINT_CHANGED = 0x03,

  // Mining channel messages
  OPEN_STANDARD_MINING_CHANNEL = 0x10,
  OPEN_STANDARD_MINING_CHANNEL_SUCCESS = 0x11,
  OPEN_STANDARD_MINING_CHANNEL_ERROR = 0x12,
  CLOSE_CHANNEL = 0x18,

  // Share submission
  SUBMIT_SHARES_STANDARD = 0x1a,
  SUBMIT_SHARES_SUCCESS = 0x1c,
  SUBMIT_SHARES_ERROR = 0x1d,

  // Extended Mining Channels
  OPEN_EXTENDED_MINING_CHANNEL = 0x13,
  OPEN_EXTENDED_MINING_CHANNEL_SUCCESS = 0x14,
  SET_EXTRANONCE_PREFIX = 0x19,
  SET_GROUP_CHANNEL = 0x25,

  // Share submission (extended)
  SUBMIT_SHARES_EXTENDED = 0x1b,

  // Job & target
  NEW_MINING_JOB = 0x15,
  NEW_EXTENDED_MINING_JOB = 0x1f,
  SET_NEW_PREV_HASH = 0x20,
  SET_TARGET = 0x21,

  // Channel management
  UPDATE_CHANNEL = 0x16,
  UPDATE_CHANNEL_ERROR = 0x17,

  // Mining Protocol - Custom Job Bridge
  SET_CUSTOM_MINING_JOB = 0x22,
  SET_CUSTOM_MINING_JOB_SUCCESS = 0x23,
  SET_CUSTOM_MINING_JOB_ERROR = 0x24,

  // Reconnect
  RECONNECT = 0x04,

  // Job Declaration Protocol
  JDP_ALLOCATE_MINING_JOB_TOKEN = 0x50,
  JDP_ALLOCATE_MINING_JOB_TOKEN_SUCCESS = 0x51,
  JDP_PROVIDE_MISSING_TRANSACTIONS = 0x55,
  JDP_PROVIDE_MISSING_TRANSACTIONS_SUCCESS = 0x56,
  JDP_DECLARE_MINING_JOB = 0x57,
  JDP_DECLARE_MINING_JOB_SUCCESS = 0x58,
  JDP_DECLARE_MINING_JOB_ERROR = 0x59,
  JDP_PUSH_SOLUTION = 0x60,

  // Template Distribution Protocol
  TDP_COINBASE_OUTPUT_CONSTRAINTS = 0x70,
  TDP_NEW_TEMPLATE = 0x71,
  TDP_SET_NEW_PREV_HASH = 0x72,
  TDP_REQUEST_TRANSACTION_DATA = 0x73,
  TDP_REQUEST_TRANSACTION_DATA_SUCCESS = 0x74,
  TDP_REQUEST_TRANSACTION_DATA_ERROR = 0x75,
  TDP_SUBMIT_SOLUTION = 0x76,
}

// ── Protocol Enum ───────────────────────────────────────────────────

export enum Sv2Protocol {
  MINING = 0,
  JOB_DECLARATION = 1,
  TEMPLATE_DISTRIBUTION = 2,
}

// ── Mining Setup Flags ──────────────────────────────────────────────

export enum Sv2MiningSetupFlags {
  REQUIRES_STANDARD_JOBS = 1 << 0,
  REQUIRES_WORK_SELECTION = 1 << 1,
  REQUIRES_VERSION_ROLLING = 1 << 2,
}

// ── SetupConnection.Success Flags (Mining Protocol) ─────────────────

export enum Sv2MiningSetupSuccessFlags {
  REQUIRES_FIXED_VERSION = 1 << 0,
  REQUIRES_EXTENDED_CHANNELS = 1 << 1,
}

// ── SetupConnection Flags (Job Declaration Protocol) ────────────────

export enum Sv2JdpSetupFlags {
  DECLARE_TX_DATA = 1 << 0,
}
