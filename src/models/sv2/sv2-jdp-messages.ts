// ── SV2 Job Declaration Protocol (JDP) Messages ────────────────────
// Interfaces + serialize/deserialize for all JDP message types and
// the Mining Protocol custom job bridge messages.
// Aligned with Rust SV2 reference (stratum/sv2/subprotocols/job-declaration).

import { BufferReader, BufferWriter } from './sv2-binary-codec';

// ── AllocateMiningJobToken (0x50) ──────────────────────────────────

export interface Sv2AllocateMiningJobToken {
  userIdentifier: string;  // STR0_255
  requestId: number;       // U32
}

export function serializeAllocateMiningJobToken(msg: Sv2AllocateMiningJobToken): Buffer {
  const w = new BufferWriter();
  w.writeStr0_255(msg.userIdentifier);
  w.writeU32(msg.requestId);
  return w.toBuffer();
}

export function deserializeAllocateMiningJobToken(reader: BufferReader): Sv2AllocateMiningJobToken {
  return {
    userIdentifier: reader.readStr0_255(),
    requestId: reader.readU32(),
  };
}

// ── AllocateMiningJobToken.Success (0x51) ──────────────────────────

export interface Sv2AllocateMiningJobTokenSuccess {
  requestId: number;        // U32
  miningJobToken: Buffer;   // B0_255
  coinbaseOutputs: Buffer;  // B0_64K
}

export function serializeAllocateMiningJobTokenSuccess(msg: Sv2AllocateMiningJobTokenSuccess): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.requestId);
  w.writeB0_255(msg.miningJobToken);
  w.writeB0_64K(msg.coinbaseOutputs);
  return w.toBuffer();
}

export function deserializeAllocateMiningJobTokenSuccess(reader: BufferReader): Sv2AllocateMiningJobTokenSuccess {
  return {
    requestId: reader.readU32(),
    miningJobToken: reader.readB0_255(),
    coinbaseOutputs: reader.readB0_64K(),
  };
}

// ── DeclareMiningJob (0x57) ────────────────────────────────────────

export interface Sv2DeclareMiningJob {
  requestId: number;          // U32
  miningJobToken: Buffer;     // B0_255
  version: number;            // U32
  coinbaseTxPrefix: Buffer;   // B0_64K
  coinbaseTxSuffix: Buffer;   // B0_64K
  wtxidList: Buffer[];        // SEQ0_64K<U256>
  excessData: Buffer;         // B0_64K
}

export function serializeDeclareMiningJob(msg: Sv2DeclareMiningJob): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.requestId);
  w.writeB0_255(msg.miningJobToken);
  w.writeU32(msg.version);
  w.writeB0_64K(msg.coinbaseTxPrefix);
  w.writeB0_64K(msg.coinbaseTxSuffix);
  w.writeSeq0_64K(msg.wtxidList, (writer, hash) => writer.writeU256(hash));
  w.writeB0_64K(msg.excessData);
  return w.toBuffer();
}

export function deserializeDeclareMiningJob(reader: BufferReader): Sv2DeclareMiningJob {
  return {
    requestId: reader.readU32(),
    miningJobToken: reader.readB0_255(),
    version: reader.readU32(),
    coinbaseTxPrefix: reader.readB0_64K(),
    coinbaseTxSuffix: reader.readB0_64K(),
    wtxidList: reader.readSeq0_64K((r) => r.readU256()),
    excessData: reader.readB0_64K(),
  };
}

// ── DeclareMiningJob.Success (0x58) ────────────────────────────────

export interface Sv2DeclareMiningJobSuccess {
  requestId: number;           // U32
  newMiningJobToken: Buffer;   // B0_255
}

export function serializeDeclareMiningJobSuccess(msg: Sv2DeclareMiningJobSuccess): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.requestId);
  w.writeB0_255(msg.newMiningJobToken);
  return w.toBuffer();
}

export function deserializeDeclareMiningJobSuccess(reader: BufferReader): Sv2DeclareMiningJobSuccess {
  return {
    requestId: reader.readU32(),
    newMiningJobToken: reader.readB0_255(),
  };
}

// ── DeclareMiningJob.Error (0x59) ──────────────────────────────────

export interface Sv2DeclareMiningJobError {
  requestId: number;     // U32
  errorCode: string;     // STR0_255
  errorDetails: Buffer;  // B0_64K
}

export function serializeDeclareMiningJobError(msg: Sv2DeclareMiningJobError): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.requestId);
  w.writeStr0_255(msg.errorCode);
  w.writeB0_64K(msg.errorDetails);
  return w.toBuffer();
}

export function deserializeDeclareMiningJobError(reader: BufferReader): Sv2DeclareMiningJobError {
  return {
    requestId: reader.readU32(),
    errorCode: reader.readStr0_255(),
    errorDetails: reader.readB0_64K(),
  };
}

// ── ProvideMissingTransactions (0x55) ──────────────────────────────

export interface Sv2ProvideMissingTransactions {
  requestId: number;              // U32
  unknownTxPositionList: number[]; // SEQ0_64K<U16>
}

export function serializeProvideMissingTransactions(msg: Sv2ProvideMissingTransactions): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.requestId);
  w.writeSeq0_64K(msg.unknownTxPositionList, (writer, pos) => writer.writeU16(pos));
  return w.toBuffer();
}

export function deserializeProvideMissingTransactions(reader: BufferReader): Sv2ProvideMissingTransactions {
  return {
    requestId: reader.readU32(),
    unknownTxPositionList: reader.readSeq0_64K((r) => r.readU16()),
  };
}

// ── ProvideMissingTransactions.Success (0x56) ──────────────────────

export interface Sv2ProvideMissingTransactionsSuccess {
  requestId: number;          // U32
  transactionList: Buffer[];  // SEQ0_64K<B0_16M>
}

export function serializeProvideMissingTransactionsSuccess(msg: Sv2ProvideMissingTransactionsSuccess): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.requestId);
  w.writeSeq0_64K(msg.transactionList, (writer, tx) => writer.writeB0_16M(tx));
  return w.toBuffer();
}

export function deserializeProvideMissingTransactionsSuccess(reader: BufferReader): Sv2ProvideMissingTransactionsSuccess {
  return {
    requestId: reader.readU32(),
    transactionList: reader.readSeq0_64K((r) => r.readB0_16M()),
  };
}

// ── PushSolution (0x60) ────────────────────────────────────────

export interface Sv2PushSolution {
  extranonce: Buffer;  // B0_32
  prevHash: Buffer;    // U256
  nonce: number;       // U32
  ntime: number;       // U32
  nBits: number;       // U32
  version: number;     // U32
}

export function serializePushSolution(msg: Sv2PushSolution): Buffer {
  const w = new BufferWriter();
  w.writeB0_32(msg.extranonce);
  w.writeU256(msg.prevHash);
  w.writeU32(msg.nonce);
  w.writeU32(msg.ntime);
  w.writeU32(msg.nBits);
  w.writeU32(msg.version);
  return w.toBuffer();
}

export function deserializePushSolution(reader: BufferReader): Sv2PushSolution {
  return {
    extranonce: reader.readB0_32(),
    prevHash: reader.readU256(),
    nonce: reader.readU32(),
    ntime: reader.readU32(),
    nBits: reader.readU32(),
    version: reader.readU32(),
  };
}

// ── SetCustomMiningJob (0x22) ──────────────────────────────────────

export interface Sv2SetCustomMiningJob {
  channelId: number;               // U32
  requestId: number;               // U32
  token: Buffer;                   // B0_255
  version: number;                 // U32
  prevHash: Buffer;                // U256
  minNtime: number;                // U32
  nBits: number;                   // U32
  coinbaseTxVersion: number;       // U32
  coinbasePrefix: Buffer;          // B0_255
  coinbaseTxInputNSequence: number; // U32
  coinbaseTxOutputs: Buffer;       // B0_64K
  coinbaseTxLocktime: number;      // U32
  merklePath: Buffer[];            // SEQ0_255<U256>
}

export function serializeSetCustomMiningJob(msg: Sv2SetCustomMiningJob): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.channelId);
  w.writeU32(msg.requestId);
  w.writeB0_255(msg.token);
  w.writeU32(msg.version);
  w.writeU256(msg.prevHash);
  w.writeU32(msg.minNtime);
  w.writeU32(msg.nBits);
  w.writeU32(msg.coinbaseTxVersion);
  w.writeB0_255(msg.coinbasePrefix);
  w.writeU32(msg.coinbaseTxInputNSequence);
  w.writeB0_64K(msg.coinbaseTxOutputs);
  w.writeU32(msg.coinbaseTxLocktime);
  w.writeSeq0_255(msg.merklePath, (writer, hash) => writer.writeU256(hash));
  return w.toBuffer();
}

export function deserializeSetCustomMiningJob(reader: BufferReader): Sv2SetCustomMiningJob {
  return {
    channelId: reader.readU32(),
    requestId: reader.readU32(),
    token: reader.readB0_255(),
    version: reader.readU32(),
    prevHash: reader.readU256(),
    minNtime: reader.readU32(),
    nBits: reader.readU32(),
    coinbaseTxVersion: reader.readU32(),
    coinbasePrefix: reader.readB0_255(),
    coinbaseTxInputNSequence: reader.readU32(),
    coinbaseTxOutputs: reader.readB0_64K(),
    coinbaseTxLocktime: reader.readU32(),
    merklePath: reader.readSeq0_255((r) => r.readU256()),
  };
}

// ── SetCustomMiningJob.Success (0x23) ──────────────────────────────

export interface Sv2SetCustomMiningJobSuccess {
  channelId: number; // U32
  requestId: number; // U32
  jobId: number;     // U32
}

export function serializeSetCustomMiningJobSuccess(msg: Sv2SetCustomMiningJobSuccess): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.channelId);
  w.writeU32(msg.requestId);
  w.writeU32(msg.jobId);
  return w.toBuffer();
}

export function deserializeSetCustomMiningJobSuccess(reader: BufferReader): Sv2SetCustomMiningJobSuccess {
  return {
    channelId: reader.readU32(),
    requestId: reader.readU32(),
    jobId: reader.readU32(),
  };
}

// ── SetCustomMiningJob.Error (0x24) ────────────────────────────────

export interface Sv2SetCustomMiningJobError {
  channelId: number;  // U32
  requestId: number;  // U32
  errorCode: string;  // STR0_255
}

export function serializeSetCustomMiningJobError(msg: Sv2SetCustomMiningJobError): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.channelId);
  w.writeU32(msg.requestId);
  w.writeStr0_255(msg.errorCode);
  return w.toBuffer();
}

export function deserializeSetCustomMiningJobError(reader: BufferReader): Sv2SetCustomMiningJobError {
  return {
    channelId: reader.readU32(),
    requestId: reader.readU32(),
    errorCode: reader.readStr0_255(),
  };
}
