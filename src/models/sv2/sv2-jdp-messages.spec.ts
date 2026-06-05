import { BufferReader } from './sv2-binary-codec';
import {
  Sv2AllocateMiningJobToken,
  serializeAllocateMiningJobToken,
  deserializeAllocateMiningJobToken,
  Sv2AllocateMiningJobTokenSuccess,
  serializeAllocateMiningJobTokenSuccess,
  deserializeAllocateMiningJobTokenSuccess,
  Sv2DeclareMiningJob,
  serializeDeclareMiningJob,
  deserializeDeclareMiningJob,
  Sv2DeclareMiningJobSuccess,
  serializeDeclareMiningJobSuccess,
  deserializeDeclareMiningJobSuccess,
  Sv2DeclareMiningJobError,
  serializeDeclareMiningJobError,
  deserializeDeclareMiningJobError,
  Sv2ProvideMissingTransactions,
  serializeProvideMissingTransactions,
  deserializeProvideMissingTransactions,
  Sv2ProvideMissingTransactionsSuccess,
  serializeProvideMissingTransactionsSuccess,
  deserializeProvideMissingTransactionsSuccess,
  Sv2SetCustomMiningJob,
  serializeSetCustomMiningJob,
  deserializeSetCustomMiningJob,
  Sv2SetCustomMiningJobSuccess,
  serializeSetCustomMiningJobSuccess,
  deserializeSetCustomMiningJobSuccess,
  Sv2SetCustomMiningJobError,
  serializeSetCustomMiningJobError,
  deserializeSetCustomMiningJobError,
  Sv2PushSolution,
  serializePushSolution,
  deserializePushSolution,
} from './sv2-jdp-messages';

function roundTrip<T>(
  msg: T,
  serialize: (m: T) => Buffer,
  deserialize: (r: BufferReader) => T,
): T {
  const buf = serialize(msg);
  return deserialize(new BufferReader(buf));
}

describe('SV2 JDP Messages', () => {
  it('AllocateMiningJobToken round-trips', () => {
    const msg: Sv2AllocateMiningJobToken = {
      userIdentifier: 'miner-001',
      requestId: 1,
    };
    const result = roundTrip(msg, serializeAllocateMiningJobToken, deserializeAllocateMiningJobToken);
    expect(result.userIdentifier).toBe(msg.userIdentifier);
    expect(result.requestId).toBe(msg.requestId);
  });

  it('AllocateMiningJobTokenSuccess round-trips', () => {
    const msg: Sv2AllocateMiningJobTokenSuccess = {
      requestId: 1,
      miningJobToken: Buffer.from('token123', 'utf8'),
      coinbaseOutputs: Buffer.from('cafebabe', 'hex'),
    };
    const result = roundTrip(msg, serializeAllocateMiningJobTokenSuccess, deserializeAllocateMiningJobTokenSuccess);
    expect(result.requestId).toBe(msg.requestId);
    expect(result.miningJobToken).toEqual(msg.miningJobToken);
    expect(result.coinbaseOutputs).toEqual(msg.coinbaseOutputs);
  });

  it('AllocateMiningJobTokenSuccess with empty coinbaseOutputs', () => {
    const msg: Sv2AllocateMiningJobTokenSuccess = {
      requestId: 42,
      miningJobToken: Buffer.from('tok'),
      coinbaseOutputs: Buffer.alloc(0),
    };
    const result = roundTrip(msg, serializeAllocateMiningJobTokenSuccess, deserializeAllocateMiningJobTokenSuccess);
    expect(result.coinbaseOutputs.length).toBe(0);
  });

  it('DeclareMiningJob round-trips', () => {
    const wtxid1 = Buffer.alloc(32, 0x11);
    const wtxid2 = Buffer.alloc(32, 0x22);
    const msg: Sv2DeclareMiningJob = {
      requestId: 42,
      miningJobToken: Buffer.from('mytoken'),
      version: 0x20000000,
      coinbaseTxPrefix: Buffer.from('deadbeef', 'hex'),
      coinbaseTxSuffix: Buffer.from('cafebabe', 'hex'),
      wtxidList: [wtxid1, wtxid2],
      excessData: Buffer.from('extra'),
    };
    const result = roundTrip(msg, serializeDeclareMiningJob, deserializeDeclareMiningJob);
    expect(result.requestId).toBe(msg.requestId);
    expect(result.miningJobToken).toEqual(msg.miningJobToken);
    expect(result.version).toBe(msg.version);
    expect(result.coinbaseTxPrefix).toEqual(msg.coinbaseTxPrefix);
    expect(result.coinbaseTxSuffix).toEqual(msg.coinbaseTxSuffix);
    expect(result.wtxidList).toHaveLength(2);
    expect(result.wtxidList[0]).toEqual(wtxid1);
    expect(result.wtxidList[1]).toEqual(wtxid2);
    expect(result.excessData).toEqual(msg.excessData);
  });

  it('DeclareMiningJob with empty tx list', () => {
    const msg: Sv2DeclareMiningJob = {
      requestId: 1,
      miningJobToken: Buffer.alloc(0),
      version: 0x20000000,
      coinbaseTxPrefix: Buffer.alloc(0),
      coinbaseTxSuffix: Buffer.alloc(0),
      wtxidList: [],
      excessData: Buffer.alloc(0),
    };
    const result = roundTrip(msg, serializeDeclareMiningJob, deserializeDeclareMiningJob);
    expect(result.wtxidList).toHaveLength(0);
  });

  it('DeclareMiningJobSuccess round-trips', () => {
    const msg: Sv2DeclareMiningJobSuccess = {
      requestId: 42,
      newMiningJobToken: Buffer.from('newtoken'),
    };
    const result = roundTrip(msg, serializeDeclareMiningJobSuccess, deserializeDeclareMiningJobSuccess);
    expect(result).toEqual(msg);
  });

  it('DeclareMiningJobError round-trips', () => {
    const msg: Sv2DeclareMiningJobError = {
      requestId: 42,
      errorCode: 'invalid-mining-job-token',
      errorDetails: Buffer.from('Token expired'),
    };
    const result = roundTrip(msg, serializeDeclareMiningJobError, deserializeDeclareMiningJobError);
    expect(result.requestId).toBe(msg.requestId);
    expect(result.errorCode).toBe(msg.errorCode);
    expect(result.errorDetails).toEqual(msg.errorDetails);
  });

  it('ProvideMissingTransactions round-trips', () => {
    const msg: Sv2ProvideMissingTransactions = {
      requestId: 7,
      unknownTxPositionList: [0, 3, 7, 15],
    };
    const result = roundTrip(msg, serializeProvideMissingTransactions, deserializeProvideMissingTransactions);
    expect(result.requestId).toBe(msg.requestId);
    expect(result.unknownTxPositionList).toEqual([0, 3, 7, 15]);
  });

  it('ProvideMissingTransactionsSuccess round-trips (B0_16M inner type)', () => {
    const tx1 = Buffer.from('0100000001', 'hex');
    const tx2 = Buffer.from('0200000002abcdef', 'hex');
    const msg: Sv2ProvideMissingTransactionsSuccess = {
      requestId: 7,
      transactionList: [tx1, tx2],
    };
    const result = roundTrip(msg, serializeProvideMissingTransactionsSuccess, deserializeProvideMissingTransactionsSuccess);
    expect(result.requestId).toBe(msg.requestId);
    expect(result.transactionList).toHaveLength(2);
    expect(result.transactionList[0]).toEqual(tx1);
    expect(result.transactionList[1]).toEqual(tx2);
  });

  it('ProvideMissingTransactionsSuccess with large transaction (>64KB)', () => {
    const largeTx = Buffer.alloc(100000, 0xab); // 100KB > 64KB limit of B0_64K
    const msg: Sv2ProvideMissingTransactionsSuccess = {
      requestId: 1,
      transactionList: [largeTx],
    };
    const result = roundTrip(msg, serializeProvideMissingTransactionsSuccess, deserializeProvideMissingTransactionsSuccess);
    expect(result.transactionList[0].length).toBe(100000);
    expect(result.transactionList[0]).toEqual(largeTx);
  });

  it('SetCustomMiningJob round-trips', () => {
    const hash1 = Buffer.alloc(32, 0xaa);
    const msg: Sv2SetCustomMiningJob = {
      channelId: 1,
      requestId: 100,
      token: Buffer.from('mytoken'),
      version: 0x20000000,
      prevHash: Buffer.alloc(32, 0xbb),
      minNtime: 1700000000,
      nBits: 0x1d00ffff,
      coinbaseTxVersion: 2,
      coinbasePrefix: Buffer.from('deadbeef', 'hex'),
      coinbaseTxInputNSequence: 0xffffffff,
      coinbaseTxOutputs: Buffer.from('outputs'),
      coinbaseTxLocktime: 0,
      merklePath: [hash1],
    };
    const result = roundTrip(msg, serializeSetCustomMiningJob, deserializeSetCustomMiningJob);
    expect(result.channelId).toBe(msg.channelId);
    expect(result.requestId).toBe(msg.requestId);
    expect(result.token).toEqual(msg.token);
    expect(result.version).toBe(msg.version);
    expect(result.prevHash).toEqual(msg.prevHash);
    expect(result.minNtime).toBe(msg.minNtime);
    expect(result.nBits).toBe(msg.nBits);
    expect(result.coinbaseTxVersion).toBe(msg.coinbaseTxVersion);
    expect(result.coinbasePrefix).toEqual(msg.coinbasePrefix);
    expect(result.coinbaseTxInputNSequence).toBe(msg.coinbaseTxInputNSequence);
    expect(result.coinbaseTxOutputs).toEqual(msg.coinbaseTxOutputs);
    expect(result.coinbaseTxLocktime).toBe(msg.coinbaseTxLocktime);
    expect(result.merklePath).toHaveLength(1);
    expect(result.merklePath[0]).toEqual(hash1);
  });

  it('SetCustomMiningJobSuccess round-trips', () => {
    const msg: Sv2SetCustomMiningJobSuccess = {
      channelId: 1,
      requestId: 100,
      jobId: 42,
    };
    const result = roundTrip(msg, serializeSetCustomMiningJobSuccess, deserializeSetCustomMiningJobSuccess);
    expect(result).toEqual(msg);
  });

  it('SetCustomMiningJobError round-trips', () => {
    const msg: Sv2SetCustomMiningJobError = {
      channelId: 1,
      requestId: 100,
      errorCode: 'invalid-mining-job-token',
    };
    const result = roundTrip(msg, serializeSetCustomMiningJobError, deserializeSetCustomMiningJobError);
    expect(result).toEqual(msg);
  });

  it('serialized DeclareMiningJob has correct structure', () => {
    const msg: Sv2DeclareMiningJob = {
      requestId: 1,
      miningJobToken: Buffer.from([0xab]),
      version: 2,
      coinbaseTxPrefix: Buffer.alloc(0),
      coinbaseTxSuffix: Buffer.alloc(0),
      wtxidList: [],
      excessData: Buffer.alloc(0),
    };
    const buf = serializeDeclareMiningJob(msg);
    // U32(4) + B0_255(1+1) + U32(4) + B0_64K(2+0) + B0_64K(2+0) + SEQ0_64K(2+0) + B0_64K(2+0)
    // = 4 + 2 + 4 + 2 + 2 + 2 + 2 = 18
    expect(buf.length).toBe(18);
  });

  it('PushSolution round-trips', () => {
    const msg: Sv2PushSolution = {
      extranonce: Buffer.from('aabbccdd', 'hex'),
      prevHash: Buffer.alloc(32, 0x11),
      nonce: 0xdeadbeef,
      ntime: 1700000000,
      nBits: 0x1d00ffff,
      version: 0x20000000,
    };
    const result = roundTrip(msg, serializePushSolution, deserializePushSolution);
    expect(result.extranonce).toEqual(msg.extranonce);
    expect(result.prevHash).toEqual(msg.prevHash);
    expect(result.nonce).toBe(msg.nonce);
    expect(result.ntime).toBe(msg.ntime);
    expect(result.nBits).toBe(msg.nBits);
    expect(result.version).toBe(msg.version);
  });

  it('PushSolution with empty extranonce', () => {
    const msg: Sv2PushSolution = {
      extranonce: Buffer.alloc(0),
      prevHash: Buffer.alloc(32, 0xff),
      nonce: 0,
      ntime: 0,
      nBits: 0,
      version: 0,
    };
    const result = roundTrip(msg, serializePushSolution, deserializePushSolution);
    expect(result.extranonce.length).toBe(0);
    expect(result.prevHash).toEqual(msg.prevHash);
  });

  it('serialized PushSolution has correct size', () => {
    const msg: Sv2PushSolution = {
      extranonce: Buffer.alloc(8),
      prevHash: Buffer.alloc(32),
      nonce: 0,
      ntime: 0,
      nBits: 0,
      version: 0,
    };
    const buf = serializePushSolution(msg);
    // B0_32(1+8) + U256(32) + U32(4) + U32(4) + U32(4) + U32(4) = 57
    expect(buf.length).toBe(57);
  });

  it('serialized SetCustomMiningJob has correct fixed overhead', () => {
    const msg: Sv2SetCustomMiningJob = {
      channelId: 1,
      requestId: 2,
      token: Buffer.alloc(0),
      version: 0x20000000,
      prevHash: Buffer.alloc(32),
      minNtime: 0,
      nBits: 0,
      coinbaseTxVersion: 2,
      coinbasePrefix: Buffer.alloc(0),
      coinbaseTxInputNSequence: 0xffffffff,
      coinbaseTxOutputs: Buffer.alloc(0),
      coinbaseTxLocktime: 0,
      merklePath: [],
    };
    const buf = serializeSetCustomMiningJob(msg);
    // U32(4) + U32(4) + B0_255(1+0) + U32(4) + U256(32) + U32(4) + U32(4) + U32(4) +
    // B0_255(1+0) + U32(4) + B0_64K(2+0) + U32(4) + SEQ0_255(1+0)
    // = 4+4+1+4+32+4+4+4+1+4+2+4+1 = 69
    expect(buf.length).toBe(69);
  });
});
