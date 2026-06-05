// ── SV2 Mining Protocol Messages ────────────────────────────────────
// Interfaces + serialize/deserialize for each message needed for
// standard mining channels.

import { BufferReader, BufferWriter } from './sv2-binary-codec';

// ── SetupConnection (0x00) ──────────────────────────────────────────

export interface Sv2SetupConnection {
  protocol: number; // U8 (0 = Mining, 1 = Job Declaration, 2 = Template Distribution)
  minVersion: number; // U16
  maxVersion: number; // U16
  flags: number; // U32
  endpoint_host: string; // STR0_255
  endpoint_port: number; // U16
  vendor: string; // STR0_255
  hardwareVersion: string; // STR0_255
  firmwareVersion: string; // STR0_255
  deviceId: string; // STR0_255
}

export function serializeSetupConnection(msg: Sv2SetupConnection): Buffer {
  const w = new BufferWriter();
  w.writeU8(msg.protocol);
  w.writeU16(msg.minVersion);
  w.writeU16(msg.maxVersion);
  w.writeU32(msg.flags);
  w.writeStr0_255(msg.endpoint_host);
  w.writeU16(msg.endpoint_port);
  w.writeStr0_255(msg.vendor);
  w.writeStr0_255(msg.hardwareVersion);
  w.writeStr0_255(msg.firmwareVersion);
  w.writeStr0_255(msg.deviceId);
  return w.toBuffer();
}

export function deserializeSetupConnection(reader: BufferReader): Sv2SetupConnection {
  return {
    protocol: reader.readU8(),
    minVersion: reader.readU16(),
    maxVersion: reader.readU16(),
    flags: reader.readU32(),
    endpoint_host: reader.readStr0_255(),
    endpoint_port: reader.readU16(),
    vendor: reader.readStr0_255(),
    hardwareVersion: reader.readStr0_255(),
    firmwareVersion: reader.readStr0_255(),
    deviceId: reader.readStr0_255(),
  };
}

// ── SetupConnectionSuccess (0x01) ───────────────────────────────────

export interface Sv2SetupConnectionSuccess {
  usedVersion: number; // U16
  flags: number; // U32
}

export function serializeSetupConnectionSuccess(msg: Sv2SetupConnectionSuccess): Buffer {
  const w = new BufferWriter();
  w.writeU16(msg.usedVersion);
  w.writeU32(msg.flags);
  return w.toBuffer();
}

export function deserializeSetupConnectionSuccess(reader: BufferReader): Sv2SetupConnectionSuccess {
  return {
    usedVersion: reader.readU16(),
    flags: reader.readU32(),
  };
}

// ── SetupConnectionError (0x02) ─────────────────────────────────────

export interface Sv2SetupConnectionError {
  flags: number; // U32
  errorCode: string; // STR0_255
}

export function serializeSetupConnectionError(msg: Sv2SetupConnectionError): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.flags);
  w.writeStr0_255(msg.errorCode);
  return w.toBuffer();
}

export function deserializeSetupConnectionError(reader: BufferReader): Sv2SetupConnectionError {
  return {
    flags: reader.readU32(),
    errorCode: reader.readStr0_255(),
  };
}

// ── ChannelEndpointChanged (0x03) ───────────────────────────────────

export interface Sv2ChannelEndpointChanged {
  channelId: number; // U32
}

export function serializeChannelEndpointChanged(msg: Sv2ChannelEndpointChanged): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.channelId);
  return w.toBuffer();
}

export function deserializeChannelEndpointChanged(reader: BufferReader): Sv2ChannelEndpointChanged {
  return {
    channelId: reader.readU32(),
  };
}

// ── OpenStandardMiningChannel (0x10) ────────────────────────────────

export interface Sv2OpenStandardMiningChannel {
  requestId: number; // U32
  user_identity: string; // STR0_255
  nominalHashRate: number; // F32
  maxTarget: Buffer; // U256 (32 bytes LE)
}

export function serializeOpenStandardMiningChannel(msg: Sv2OpenStandardMiningChannel): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.requestId);
  w.writeStr0_255(msg.user_identity);
  w.writeF32(msg.nominalHashRate);
  w.writeU256(msg.maxTarget);
  return w.toBuffer();
}

export function deserializeOpenStandardMiningChannel(
  reader: BufferReader,
): Sv2OpenStandardMiningChannel {
  return {
    requestId: reader.readU32(),
    user_identity: reader.readStr0_255(),
    nominalHashRate: reader.readF32(),
    maxTarget: reader.readU256(),
  };
}

// ── OpenStandardMiningChannelSuccess (0x11) ─────────────────────────

export interface Sv2OpenStandardMiningChannelSuccess {
  requestId: number; // U32
  channelId: number; // U32
  target: Buffer; // U256 (32 bytes LE)
  extranonce_prefix: Buffer; // B0_32
  groupChannelId: number; // U32
}

export function serializeOpenStandardMiningChannelSuccess(
  msg: Sv2OpenStandardMiningChannelSuccess,
): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.requestId);
  w.writeU32(msg.channelId);
  w.writeU256(msg.target);
  w.writeB0_32(msg.extranonce_prefix);
  w.writeU32(msg.groupChannelId);
  return w.toBuffer();
}

export function deserializeOpenStandardMiningChannelSuccess(
  reader: BufferReader,
): Sv2OpenStandardMiningChannelSuccess {
  return {
    requestId: reader.readU32(),
    channelId: reader.readU32(),
    target: reader.readU256(),
    extranonce_prefix: reader.readB0_32(),
    groupChannelId: reader.readU32(),
  };
}

// ── OpenMiningChannel.Error (0x12) ──────────────────────────────────

export interface Sv2OpenMiningChannelError {
  requestId: number; // U32
  errorCode: string; // STR0_255
}

export function serializeOpenMiningChannelError(msg: Sv2OpenMiningChannelError): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.requestId);
  w.writeStr0_255(msg.errorCode);
  return w.toBuffer();
}

export function deserializeOpenMiningChannelError(reader: BufferReader): Sv2OpenMiningChannelError {
  return {
    requestId: reader.readU32(),
    errorCode: reader.readStr0_255(),
  };
}

// ── NewMiningJob (0x15) ─────────────────────────────────────────────

export interface Sv2NewMiningJob {
  channelId: number; // U32
  jobId: number; // U32
  minNtime: number | null; // Sv2Option<U32> - null = future job, number = min ntime value
  version: number; // U32
  merkleRoot: Buffer; // U256 (32 bytes)
}

export function serializeNewMiningJob(msg: Sv2NewMiningJob): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.channelId);
  w.writeU32(msg.jobId);
  w.writeOptionU32(msg.minNtime);
  w.writeU32(msg.version);
  w.writeU256(msg.merkleRoot);
  return w.toBuffer();
}

export function deserializeNewMiningJob(reader: BufferReader): Sv2NewMiningJob {
  return {
    channelId: reader.readU32(),
    jobId: reader.readU32(),
    minNtime: reader.readOptionU32(),
    version: reader.readU32(),
    merkleRoot: reader.readU256(),
  };
}

// ── SetNewPrevHash (0x20) ───────────────────────────────────────────

export interface Sv2SetNewPrevHash {
  channelId: number; // U32
  jobId: number; // U32
  prevHash: Buffer; // U256 (32 bytes)
  minNtime: number; // U32
  nBits: number; // U32
}

export function serializeSetNewPrevHash(msg: Sv2SetNewPrevHash): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.channelId);
  w.writeU32(msg.jobId);
  w.writeU256(msg.prevHash);
  w.writeU32(msg.minNtime);
  w.writeU32(msg.nBits);
  return w.toBuffer();
}

export function deserializeSetNewPrevHash(reader: BufferReader): Sv2SetNewPrevHash {
  return {
    channelId: reader.readU32(),
    jobId: reader.readU32(),
    prevHash: reader.readU256(),
    minNtime: reader.readU32(),
    nBits: reader.readU32(),
  };
}

// ── SetTarget (0x21) ────────────────────────────────────────────────

export interface Sv2SetTarget {
  channelId: number; // U32
  maxTarget: Buffer; // U256 (32 bytes)
}

export function serializeSetTarget(msg: Sv2SetTarget): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.channelId);
  w.writeU256(msg.maxTarget);
  return w.toBuffer();
}

export function deserializeSetTarget(reader: BufferReader): Sv2SetTarget {
  return {
    channelId: reader.readU32(),
    maxTarget: reader.readU256(),
  };
}

// ── SubmitSharesStandard (0x1a) ─────────────────────────────────────

export interface Sv2SubmitSharesStandard {
  channelId: number; // U32
  sequenceNumber: number; // U32
  jobId: number; // U32
  nonce: number; // U32
  ntime: number; // U32
  version: number; // U32
}

export function serializeSubmitSharesStandard(msg: Sv2SubmitSharesStandard): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.channelId);
  w.writeU32(msg.sequenceNumber);
  w.writeU32(msg.jobId);
  w.writeU32(msg.nonce);
  w.writeU32(msg.ntime);
  w.writeU32(msg.version);
  return w.toBuffer();
}

export function deserializeSubmitSharesStandard(reader: BufferReader): Sv2SubmitSharesStandard {
  return {
    channelId: reader.readU32(),
    sequenceNumber: reader.readU32(),
    jobId: reader.readU32(),
    nonce: reader.readU32(),
    ntime: reader.readU32(),
    version: reader.readU32(),
  };
}

// ── SubmitSharesSuccess (0x1c) ──────────────────────────────────────

export interface Sv2SubmitSharesSuccess {
  channelId: number; // U32
  lastSequenceNumber: number; // U32
  newSubmitsAcceptedCount: number; // U32
  newSharesSum: bigint; // U64
}

export function serializeSubmitSharesSuccess(msg: Sv2SubmitSharesSuccess): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.channelId);
  w.writeU32(msg.lastSequenceNumber);
  w.writeU32(msg.newSubmitsAcceptedCount);
  w.writeU64(msg.newSharesSum);
  return w.toBuffer();
}

export function deserializeSubmitSharesSuccess(reader: BufferReader): Sv2SubmitSharesSuccess {
  return {
    channelId: reader.readU32(),
    lastSequenceNumber: reader.readU32(),
    newSubmitsAcceptedCount: reader.readU32(),
    newSharesSum: reader.readU64(),
  };
}

// ── SubmitSharesError (0x1d) ────────────────────────────────────────

export interface Sv2SubmitSharesError {
  channelId: number; // U32
  sequenceNumber: number; // U32
  errorCode: string; // STR0_255
}

export function serializeSubmitSharesError(msg: Sv2SubmitSharesError): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.channelId);
  w.writeU32(msg.sequenceNumber);
  w.writeStr0_255(msg.errorCode);
  return w.toBuffer();
}

export function deserializeSubmitSharesError(reader: BufferReader): Sv2SubmitSharesError {
  return {
    channelId: reader.readU32(),
    sequenceNumber: reader.readU32(),
    errorCode: reader.readStr0_255(),
  };
}

// ── CloseChannel (0x18) ─────────────────────────────────────────────

export interface Sv2CloseChannel {
  channelId: number; // U32
  reasonCode: string; // STR0_255
}

export function serializeCloseChannel(msg: Sv2CloseChannel): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.channelId);
  w.writeStr0_255(msg.reasonCode);
  return w.toBuffer();
}

export function deserializeCloseChannel(reader: BufferReader): Sv2CloseChannel {
  return {
    channelId: reader.readU32(),
    reasonCode: reader.readStr0_255(),
  };
}

// ── UpdateChannel (0x16) ────────────────────────────────────────────

export interface Sv2UpdateChannel {
  channelId: number;        // U32
  nominalHashRate: number;  // F32
  maximumTarget: Buffer;    // U256 (32 bytes LE)
}

export function serializeUpdateChannel(msg: Sv2UpdateChannel): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.channelId);
  w.writeF32(msg.nominalHashRate);
  w.writeU256(msg.maximumTarget);
  return w.toBuffer();
}

export function deserializeUpdateChannel(reader: BufferReader): Sv2UpdateChannel {
  return {
    channelId: reader.readU32(),
    nominalHashRate: reader.readF32(),
    maximumTarget: reader.readU256(),
  };
}

// ── UpdateChannel.Error (0x17) ──────────────────────────────────────

export interface Sv2UpdateChannelError {
  channelId: number;  // U32
  errorCode: string;  // STR0_255
}

export function serializeUpdateChannelError(msg: Sv2UpdateChannelError): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.channelId);
  w.writeStr0_255(msg.errorCode);
  return w.toBuffer();
}

export function deserializeUpdateChannelError(reader: BufferReader): Sv2UpdateChannelError {
  return {
    channelId: reader.readU32(),
    errorCode: reader.readStr0_255(),
  };
}

// ── Extension 1: Extensions Negotiation (extension_type = 0x0001) ───
// Spec: extensions/0x0001-extensions-negotiation.md
// RequestExtensions     msgType 0x00  (client → pool)
// RequestExtensions.Success msgType 0x01  (pool → client)
// RequestExtensions.Error   msgType 0x02  (pool → client)

export const SV2_EXTENSION_NEGOTIATION_ID = 0x0001;

export interface Sv2RequestExtensions {
  requestId: number;            // U16
  requestedExtensions: number[]; // SEQ0_64K[U16]
}

export function deserializeRequestExtensions(reader: BufferReader): Sv2RequestExtensions {
  return {
    requestId: reader.readU16(),
    requestedExtensions: reader.readSeq0_64K((r) => r.readU16()),
  };
}

export interface Sv2RequestExtensionsSuccess {
  requestId: number;             // U16
  supportedExtensions: number[]; // SEQ0_64K[U16]
}

export function serializeRequestExtensionsSuccess(msg: Sv2RequestExtensionsSuccess): Buffer {
  const w = new BufferWriter();
  w.writeU16(msg.requestId);
  w.writeSeq0_64K(msg.supportedExtensions, (writer, ext) => writer.writeU16(ext));
  return w.toBuffer();
}

// ── Reconnect (0x04) ────────────────────────────────────────────────

export interface Sv2Reconnect {
  newHost: string;  // STR0_255
  newPort: number;  // U16
}

export function serializeReconnect(msg: Sv2Reconnect): Buffer {
  const w = new BufferWriter();
  w.writeStr0_255(msg.newHost);
  w.writeU16(msg.newPort);
  return w.toBuffer();
}

export function deserializeReconnect(reader: BufferReader): Sv2Reconnect {
  return {
    newHost: reader.readStr0_255(),
    newPort: reader.readU16(),
  };
}
