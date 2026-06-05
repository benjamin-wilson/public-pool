// ── SV2 Template Distribution Protocol (TDP) Messages ──────────────
// Interfaces + serialize/deserialize for all TDP message types.

import { BufferReader, BufferWriter } from './sv2-binary-codec';

// ── CoinbaseOutputConstraints (0x70) ────────────────────────────────

export interface Sv2TdpCoinbaseOutputConstraints {
  coinbaseOutputMaxAdditionalSize: number;   // U32
  coinbaseOutputMaxAdditionalSigops: number; // U16
}

export function serializeTdpCoinbaseOutputConstraints(msg: Sv2TdpCoinbaseOutputConstraints): Buffer {
  const w = new BufferWriter();
  w.writeU32(msg.coinbaseOutputMaxAdditionalSize);
  w.writeU16(msg.coinbaseOutputMaxAdditionalSigops);
  return w.toBuffer();
}

export function deserializeTdpCoinbaseOutputConstraints(reader: BufferReader): Sv2TdpCoinbaseOutputConstraints {
  return {
    coinbaseOutputMaxAdditionalSize: reader.readU32(),
    coinbaseOutputMaxAdditionalSigops: reader.readU16(),
  };
}

// ── NewTemplate (0x71) ─────────────────────────────────────────────

export interface Sv2TdpNewTemplate {
  templateId: bigint;              // U64
  futureTemplate: boolean;         // BOOL
  version: number;                 // U32
  coinbaseTxVersion: number;       // U32
  coinbasePrefix: Buffer;          // B0_255
  coinbaseTxInputSequence: number; // U32
  coinbaseTxValueRemaining: bigint; // U64
  coinbaseTxOutputsCount: number;  // U32
  coinbaseTxOutputs: Buffer;       // B0_64K (serialized outputs)
  coinbaseTxLocktime: number;      // U32
  merklePath: Buffer[];            // SEQ0_255<U256>
}

export function serializeTdpNewTemplate(msg: Sv2TdpNewTemplate): Buffer {
  const w = new BufferWriter();
  w.writeU64(msg.templateId);
  w.writeBool(msg.futureTemplate);
  w.writeU32(msg.version);
  w.writeU32(msg.coinbaseTxVersion);
  w.writeB0_255(msg.coinbasePrefix);
  w.writeU32(msg.coinbaseTxInputSequence);
  w.writeU64(msg.coinbaseTxValueRemaining);
  w.writeU32(msg.coinbaseTxOutputsCount);
  w.writeB0_64K(msg.coinbaseTxOutputs);
  w.writeU32(msg.coinbaseTxLocktime);
  w.writeSeq0_255(msg.merklePath, (writer, hash) => writer.writeU256(hash));
  return w.toBuffer();
}

export function deserializeTdpNewTemplate(reader: BufferReader): Sv2TdpNewTemplate {
  return {
    templateId: reader.readU64(),
    futureTemplate: reader.readBool(),
    version: reader.readU32(),
    coinbaseTxVersion: reader.readU32(),
    coinbasePrefix: reader.readB0_255(),
    coinbaseTxInputSequence: reader.readU32(),
    coinbaseTxValueRemaining: reader.readU64(),
    coinbaseTxOutputsCount: reader.readU32(),
    coinbaseTxOutputs: reader.readB0_64K(),
    coinbaseTxLocktime: reader.readU32(),
    merklePath: reader.readSeq0_255((r) => r.readU256()),
  };
}

// ── SetNewPrevHash (0x72) ──────────────────────────────────────────

export interface Sv2TdpSetNewPrevHash {
  templateId: bigint;     // U64
  prevHash: Buffer;       // U256
  headerTimestamp: number; // U32
  nBits: number;          // U32
  target: Buffer;         // U256
}

export function serializeTdpSetNewPrevHash(msg: Sv2TdpSetNewPrevHash): Buffer {
  const w = new BufferWriter();
  w.writeU64(msg.templateId);
  w.writeU256(msg.prevHash);
  w.writeU32(msg.headerTimestamp);
  w.writeU32(msg.nBits);
  w.writeU256(msg.target);
  return w.toBuffer();
}

export function deserializeTdpSetNewPrevHash(reader: BufferReader): Sv2TdpSetNewPrevHash {
  return {
    templateId: reader.readU64(),
    prevHash: reader.readU256(),
    headerTimestamp: reader.readU32(),
    nBits: reader.readU32(),
    target: reader.readU256(),
  };
}

// ── RequestTransactionData (0x73) ──────────────────────────────────

export interface Sv2TdpRequestTransactionData {
  templateId: bigint; // U64
}

export function serializeTdpRequestTransactionData(msg: Sv2TdpRequestTransactionData): Buffer {
  const w = new BufferWriter();
  w.writeU64(msg.templateId);
  return w.toBuffer();
}

export function deserializeTdpRequestTransactionData(reader: BufferReader): Sv2TdpRequestTransactionData {
  return {
    templateId: reader.readU64(),
  };
}

// ── RequestTransactionData.Success (0x74) ──────────────────────────

export interface Sv2TdpRequestTransactionDataSuccess {
  templateId: bigint;        // U64
  excessData: Buffer;        // B0_64K
  transactionList: Buffer[]; // SEQ0_64K<B0_16M>
}

export function serializeTdpRequestTransactionDataSuccess(msg: Sv2TdpRequestTransactionDataSuccess): Buffer {
  const w = new BufferWriter();
  w.writeU64(msg.templateId);
  w.writeB0_64K(msg.excessData);
  w.writeSeq0_64K(msg.transactionList, (writer, tx) => writer.writeB0_16M(tx));
  return w.toBuffer();
}

export function deserializeTdpRequestTransactionDataSuccess(reader: BufferReader): Sv2TdpRequestTransactionDataSuccess {
  return {
    templateId: reader.readU64(),
    excessData: reader.readB0_64K(),
    transactionList: reader.readSeq0_64K((r) => r.readB0_16M()),
  };
}

// ── RequestTransactionData.Error (0x75) ────────────────────────────

export interface Sv2TdpRequestTransactionDataError {
  templateId: bigint;  // U64
  errorCode: string;   // STR0_255
}

export function serializeTdpRequestTransactionDataError(msg: Sv2TdpRequestTransactionDataError): Buffer {
  const w = new BufferWriter();
  w.writeU64(msg.templateId);
  w.writeStr0_255(msg.errorCode);
  return w.toBuffer();
}

export function deserializeTdpRequestTransactionDataError(reader: BufferReader): Sv2TdpRequestTransactionDataError {
  return {
    templateId: reader.readU64(),
    errorCode: reader.readStr0_255(),
  };
}

// ── SubmitSolution (0x76) ──────────────────────────────────────────

export interface Sv2TdpSubmitSolution {
  templateId: bigint;     // U64
  version: number;        // U32
  headerTimestamp: number; // U32
  headerNonce: number;    // U32
  coinbaseTx: Buffer;     // B0_64K
}

export function serializeTdpSubmitSolution(msg: Sv2TdpSubmitSolution): Buffer {
  const w = new BufferWriter();
  w.writeU64(msg.templateId);
  w.writeU32(msg.version);
  w.writeU32(msg.headerTimestamp);
  w.writeU32(msg.headerNonce);
  w.writeB0_64K(msg.coinbaseTx);
  return w.toBuffer();
}

export function deserializeTdpSubmitSolution(reader: BufferReader): Sv2TdpSubmitSolution {
  return {
    templateId: reader.readU64(),
    version: reader.readU32(),
    headerTimestamp: reader.readU32(),
    headerNonce: reader.readU32(),
    coinbaseTx: reader.readB0_64K(),
  };
}
