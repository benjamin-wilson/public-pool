// ── SV2 Extended Mining Channel Messages ────────────────────────────
// Interfaces + serialize/deserialize for extended channel message types.

import { BufferReader, BufferWriter } from './sv2-binary-codec';

// ── OpenExtendedMiningChannel (0x13) ───────────────────────────────

export interface Sv2OpenExtendedMiningChannel {
  requestId: number;         // U32
  userIdentity: string;      // STR0_255
  nominalHashRate: number;   // F32
  maxTarget: Buffer;         // U256 (32 bytes LE)
  minExtranonceSize: number; // U16
}

export function serializeOpenExtendedMiningChannel(msg: Sv2OpenExtendedMiningChannel): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.requestId);
  w.writeStr0_255(msg.userIdentity);
  w.writeF32(msg.nominalHashRate);
  w.writeU256(msg.maxTarget);
  w.writeU16(msg.minExtranonceSize);
  return w.toBuffer();
}

export function deserializeOpenExtendedMiningChannel(reader: BufferReader): Sv2OpenExtendedMiningChannel {
  return {
    requestId: reader.readU32(),
    userIdentity: reader.readStr0_255(),
    nominalHashRate: reader.readF32(),
    maxTarget: reader.readU256(),
    minExtranonceSize: reader.readU16(),
  };
}

// ── OpenExtendedMiningChannel.Success (0x14) ───────────────────────

export interface Sv2OpenExtendedMiningChannelSuccess {
  requestId: number;       // U32
  channelId: number;       // U32
  target: Buffer;          // U256
  extranonceSize: number;  // U16
  extranoncePrefix: Buffer; // B0_32
  groupChannelId: number;  // U32
}

export function serializeOpenExtendedMiningChannelSuccess(msg: Sv2OpenExtendedMiningChannelSuccess): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.requestId);
  w.writeU32(msg.channelId);
  w.writeU256(msg.target);
  w.writeU16(msg.extranonceSize);
  w.writeB0_32(msg.extranoncePrefix);
  w.writeU32(msg.groupChannelId);
  return w.toBuffer();
}

export function deserializeOpenExtendedMiningChannelSuccess(reader: BufferReader): Sv2OpenExtendedMiningChannelSuccess {
  return {
    requestId: reader.readU32(),
    channelId: reader.readU32(),
    target: reader.readU256(),
    extranonceSize: reader.readU16(),
    extranoncePrefix: reader.readB0_32(),
    groupChannelId: reader.readU32(),
  };
}

// ── NewExtendedMiningJob (0x1f) ────────────────────────────────────

export interface Sv2NewExtendedMiningJob {
  channelId: number;            // U32
  jobId: number;                // U32
  minNtime: number | null;      // Sv2Option<U32> - null = future job (activated by SetNewPrevHash), Some(ts) = mine immediately
  version: number;              // U32
  versionRollingAllowed: boolean; // BOOL
  merklePath: Buffer[];         // SEQ0_255<U256>
  coinbasePrefix: Buffer;       // B0_64K
  coinbaseSuffix: Buffer;       // B0_64K
}

export function serializeNewExtendedMiningJob(msg: Sv2NewExtendedMiningJob): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.channelId);
  w.writeU32(msg.jobId);
  w.writeOptionU32(msg.minNtime);
  w.writeU32(msg.version);
  w.writeBool(msg.versionRollingAllowed);
  w.writeSeq0_255(msg.merklePath, (writer, hash) => writer.writeU256(hash));
  w.writeB0_64K(msg.coinbasePrefix);
  w.writeB0_64K(msg.coinbaseSuffix);
  return w.toBuffer();
}

export function deserializeNewExtendedMiningJob(reader: BufferReader): Sv2NewExtendedMiningJob {
  return {
    channelId: reader.readU32(),
    jobId: reader.readU32(),
    minNtime: reader.readOptionU32(),
    version: reader.readU32(),
    versionRollingAllowed: reader.readBool(),
    merklePath: reader.readSeq0_255((r) => r.readU256()),
    coinbasePrefix: reader.readB0_64K(),
    coinbaseSuffix: reader.readB0_64K(),
  };
}

// ── SubmitSharesExtended (0x1b) ────────────────────────────────────

export interface Sv2SubmitSharesExtended {
  channelId: number;     // U32
  sequenceNumber: number; // U32
  jobId: number;         // U32
  nonce: number;         // U32
  ntime: number;         // U32
  version: number;       // U32
  extranonce: Buffer;    // B0_32
}

export function serializeSubmitSharesExtended(msg: Sv2SubmitSharesExtended): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.channelId);
  w.writeU32(msg.sequenceNumber);
  w.writeU32(msg.jobId);
  w.writeU32(msg.nonce);
  w.writeU32(msg.ntime);
  w.writeU32(msg.version);
  w.writeB0_32(msg.extranonce);
  return w.toBuffer();
}

export function deserializeSubmitSharesExtended(reader: BufferReader): Sv2SubmitSharesExtended {
  return {
    channelId: reader.readU32(),
    sequenceNumber: reader.readU32(),
    jobId: reader.readU32(),
    nonce: reader.readU32(),
    ntime: reader.readU32(),
    version: reader.readU32(),
    extranonce: reader.readB0_32(),
  };
}

// ── SetExtranoncePrefix (0x19) ─────────────────────────────────────

export interface Sv2SetExtranoncePrefix {
  channelId: number;       // U32
  extranoncePrefix: Buffer; // B0_32
}

export function serializeSetExtranoncePrefix(msg: Sv2SetExtranoncePrefix): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.channelId);
  w.writeB0_32(msg.extranoncePrefix);
  return w.toBuffer();
}

export function deserializeSetExtranoncePrefix(reader: BufferReader): Sv2SetExtranoncePrefix {
  return {
    channelId: reader.readU32(),
    extranoncePrefix: reader.readB0_32(),
  };
}

// ── SetGroupChannel (0x25) ─────────────────────────────────────────

export interface Sv2SetGroupChannel {
  groupChannelId: number; // U32
  channelIds: number[];   // SEQ0_64K[U32]
}

export function serializeSetGroupChannel(msg: Sv2SetGroupChannel): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.groupChannelId);
  w.writeSeq0_64K(msg.channelIds, (writer, id) => writer.writeU32(id));
  return w.toBuffer();
}

export function deserializeSetGroupChannel(reader: BufferReader): Sv2SetGroupChannel {
  return {
    groupChannelId: reader.readU32(),
    channelIds: reader.readSeq0_64K((r) => r.readU32()),
  };
}
