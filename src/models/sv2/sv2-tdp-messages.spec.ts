import { BufferReader } from './sv2-binary-codec';
import {
  Sv2TdpCoinbaseOutputConstraints,
  serializeTdpCoinbaseOutputConstraints,
  deserializeTdpCoinbaseOutputConstraints,
  Sv2TdpNewTemplate,
  serializeTdpNewTemplate,
  deserializeTdpNewTemplate,
  Sv2TdpSetNewPrevHash,
  serializeTdpSetNewPrevHash,
  deserializeTdpSetNewPrevHash,
  Sv2TdpRequestTransactionData,
  serializeTdpRequestTransactionData,
  deserializeTdpRequestTransactionData,
  Sv2TdpRequestTransactionDataSuccess,
  serializeTdpRequestTransactionDataSuccess,
  deserializeTdpRequestTransactionDataSuccess,
  Sv2TdpRequestTransactionDataError,
  serializeTdpRequestTransactionDataError,
  deserializeTdpRequestTransactionDataError,
  Sv2TdpSubmitSolution,
  serializeTdpSubmitSolution,
  deserializeTdpSubmitSolution,
} from './sv2-tdp-messages';

function roundTrip<T>(
  msg: T,
  serialize: (m: T) => Buffer,
  deserialize: (r: BufferReader) => T,
): T {
  const buf = serialize(msg);
  return deserialize(new BufferReader(buf));
}

describe('SV2 TDP Messages', () => {
  it('CoinbaseOutputConstraints round-trips', () => {
    const msg: Sv2TdpCoinbaseOutputConstraints = {
      coinbaseOutputMaxAdditionalSize: 128,
      coinbaseOutputMaxAdditionalSigops: 400,
    };
    const result = roundTrip(msg, serializeTdpCoinbaseOutputConstraints, deserializeTdpCoinbaseOutputConstraints);
    expect(result).toEqual(msg);
  });

  it('NewTemplate round-trips with merkle path', () => {
    const hash1 = Buffer.alloc(32, 0xaa);
    const hash2 = Buffer.alloc(32, 0xbb);
    const msg: Sv2TdpNewTemplate = {
      templateId: 42n,
      futureTemplate: false,
      version: 0x20000000,
      coinbaseTxVersion: 2,
      coinbasePrefix: Buffer.from('deadbeef', 'hex'),
      coinbaseTxInputSequence: 0xffffffff,
      coinbaseTxValueRemaining: 625000000n,
      coinbaseTxOutputsCount: 1,
      coinbaseTxOutputs: Buffer.from('cafebabe', 'hex'),
      coinbaseTxLocktime: 0,
      merklePath: [hash1, hash2],
    };
    const result = roundTrip(msg, serializeTdpNewTemplate, deserializeTdpNewTemplate);
    expect(result.templateId).toBe(msg.templateId);
    expect(result.futureTemplate).toBe(msg.futureTemplate);
    expect(result.version).toBe(msg.version);
    expect(result.coinbasePrefix).toEqual(msg.coinbasePrefix);
    expect(result.coinbaseTxVersion).toBe(msg.coinbaseTxVersion);
    expect(result.coinbaseTxInputSequence).toBe(msg.coinbaseTxInputSequence);
    expect(result.coinbaseTxValueRemaining).toBe(msg.coinbaseTxValueRemaining);
    expect(result.coinbaseTxOutputsCount).toBe(msg.coinbaseTxOutputsCount);
    expect(result.coinbaseTxOutputs).toEqual(msg.coinbaseTxOutputs);
    expect(result.coinbaseTxLocktime).toBe(msg.coinbaseTxLocktime);
    expect(result.merklePath).toHaveLength(2);
    expect(result.merklePath[0]).toEqual(hash1);
    expect(result.merklePath[1]).toEqual(hash2);
  });

  it('NewTemplate round-trips with empty merkle path', () => {
    const msg: Sv2TdpNewTemplate = {
      templateId: 1n,
      futureTemplate: true,
      version: 0x20000000,
      coinbaseTxVersion: 2,
      coinbasePrefix: Buffer.alloc(0),
      coinbaseTxInputSequence: 0xffffffff,
      coinbaseTxValueRemaining: 0n,
      coinbaseTxOutputsCount: 0,
      coinbaseTxOutputs: Buffer.alloc(0),
      coinbaseTxLocktime: 0,
      merklePath: [],
    };
    const result = roundTrip(msg, serializeTdpNewTemplate, deserializeTdpNewTemplate);
    expect(result.merklePath).toHaveLength(0);
    expect(result.futureTemplate).toBe(true);
  });

  it('NewTemplate round-trips with large coinbase data', () => {
    const largeCoinbase = Buffer.alloc(100, 0xcc); // B0_255 max 255 bytes
    const largeOutputs = Buffer.alloc(2000, 0xdd);
    const msg: Sv2TdpNewTemplate = {
      templateId: 999n,
      futureTemplate: false,
      version: 0x20400000,
      coinbaseTxVersion: 2,
      coinbasePrefix: largeCoinbase,
      coinbaseTxInputSequence: 0xfffffffe,
      coinbaseTxValueRemaining: 312500000n,
      coinbaseTxOutputsCount: 3,
      coinbaseTxOutputs: largeOutputs,
      coinbaseTxLocktime: 500000,
      merklePath: Array.from({ length: 12 }, (_, i) => Buffer.alloc(32, i)),
    };
    const result = roundTrip(msg, serializeTdpNewTemplate, deserializeTdpNewTemplate);
    expect(result.coinbasePrefix).toEqual(largeCoinbase); // B0_255, 100 bytes
    expect(result.coinbaseTxOutputs).toEqual(largeOutputs);
    expect(result.merklePath).toHaveLength(12);
  });

  it('SetNewPrevHash round-trips', () => {
    const prevHash = Buffer.alloc(32, 0xab);
    const target = Buffer.alloc(32, 0x00);
    target[0] = 0xff;
    const msg: Sv2TdpSetNewPrevHash = {
      templateId: 42n,
      prevHash,
      headerTimestamp: 1700000000,
      nBits: 0x1d00ffff,
      target,
    };
    const result = roundTrip(msg, serializeTdpSetNewPrevHash, deserializeTdpSetNewPrevHash);
    expect(result).toEqual(msg);
  });

  it('RequestTransactionData round-trips', () => {
    const msg: Sv2TdpRequestTransactionData = {
      templateId: 100n,
    };
    const result = roundTrip(msg, serializeTdpRequestTransactionData, deserializeTdpRequestTransactionData);
    expect(result).toEqual(msg);
  });

  it('RequestTransactionData.Success round-trips with transactions', () => {
    const tx1 = Buffer.from('0100000001', 'hex');
    const tx2 = Buffer.from('0200000002abcd', 'hex');
    const msg: Sv2TdpRequestTransactionDataSuccess = {
      templateId: 100n,
      excessData: Buffer.from('extra', 'utf8'),
      transactionList: [tx1, tx2],
    };
    const result = roundTrip(
      msg,
      serializeTdpRequestTransactionDataSuccess,
      deserializeTdpRequestTransactionDataSuccess,
    );
    expect(result.templateId).toBe(msg.templateId);
    expect(result.excessData).toEqual(msg.excessData);
    expect(result.transactionList).toHaveLength(2);
    expect(result.transactionList[0]).toEqual(tx1);
    expect(result.transactionList[1]).toEqual(tx2);
  });

  it('RequestTransactionData.Success round-trips with empty transaction list', () => {
    const msg: Sv2TdpRequestTransactionDataSuccess = {
      templateId: 1n,
      excessData: Buffer.alloc(0),
      transactionList: [],
    };
    const result = roundTrip(
      msg,
      serializeTdpRequestTransactionDataSuccess,
      deserializeTdpRequestTransactionDataSuccess,
    );
    expect(result.transactionList).toHaveLength(0);
  });

  it('RequestTransactionData.Error round-trips', () => {
    const msg: Sv2TdpRequestTransactionDataError = {
      templateId: 42n,
      errorCode: 'template-not-found',
    };
    const result = roundTrip(
      msg,
      serializeTdpRequestTransactionDataError,
      deserializeTdpRequestTransactionDataError,
    );
    expect(result).toEqual(msg);
  });

  it('SubmitSolution round-trips', () => {
    const coinbaseTx = Buffer.alloc(250, 0xef);
    const msg: Sv2TdpSubmitSolution = {
      templateId: 42n,
      version: 0x20000000,
      headerTimestamp: 1700000000,
      headerNonce: 0xdeadbeef,
      coinbaseTx,
    };
    const result = roundTrip(msg, serializeTdpSubmitSolution, deserializeTdpSubmitSolution);
    expect(result.templateId).toBe(msg.templateId);
    expect(result.version).toBe(msg.version);
    expect(result.headerTimestamp).toBe(msg.headerTimestamp);
    expect(result.headerNonce).toBe(msg.headerNonce);
    expect(result.coinbaseTx).toEqual(coinbaseTx);
  });

  it('serialized NewTemplate has correct byte layout', () => {
    const msg: Sv2TdpNewTemplate = {
      templateId: 1n,
      futureTemplate: false,
      version: 0x20000000,
      coinbaseTxVersion: 2,
      coinbasePrefix: Buffer.from([0xab]),
      coinbaseTxInputSequence: 0xffffffff,
      coinbaseTxValueRemaining: 100n,
      coinbaseTxOutputsCount: 0,
      coinbaseTxOutputs: Buffer.alloc(0),
      coinbaseTxLocktime: 0,
      merklePath: [],
    };
    const buf = serializeTdpNewTemplate(msg);
    // U64(8) + BOOL(1) + U32(4) + U32(4) + B0_255(1+1) + U32(4) + U64(8) + U32(4) + B0_64K(2+0) + U32(4) + SEQ0_255(1+0)
    // = 8 + 1 + 4 + 4 + 2 + 4 + 8 + 4 + 2 + 4 + 1 = 42
    expect(buf.length).toBe(42);
    expect(buf.readBigUInt64LE(0)).toBe(1n);
    expect(buf[8]).toBe(0); // futureTemplate = false
  });
});
