import { BufferReader } from './sv2-binary-codec';
import {
  Sv2OpenExtendedMiningChannel,
  serializeOpenExtendedMiningChannel,
  deserializeOpenExtendedMiningChannel,
  Sv2OpenExtendedMiningChannelSuccess,
  serializeOpenExtendedMiningChannelSuccess,
  deserializeOpenExtendedMiningChannelSuccess,
  Sv2NewExtendedMiningJob,
  serializeNewExtendedMiningJob,
  deserializeNewExtendedMiningJob,
  Sv2SubmitSharesExtended,
  serializeSubmitSharesExtended,
  deserializeSubmitSharesExtended,
  Sv2SetExtranoncePrefix,
  serializeSetExtranoncePrefix,
  deserializeSetExtranoncePrefix,
  Sv2SetGroupChannel,
  serializeSetGroupChannel,
  deserializeSetGroupChannel,
} from './sv2-extended-messages';

function roundTrip<T>(
  msg: T,
  serialize: (m: T) => Buffer,
  deserialize: (r: BufferReader) => T,
): T {
  const buf = serialize(msg);
  return deserialize(new BufferReader(buf));
}

describe('SV2 Extended Mining Channel Messages', () => {
  it('OpenExtendedMiningChannel round-trips', () => {
    const maxTarget = Buffer.alloc(32, 0x00);
    maxTarget[0] = 0xff;
    const msg: Sv2OpenExtendedMiningChannel = {
      requestId: 1,
      userIdentity: 'bc1qtest.worker1',
      nominalHashRate: 500000.0,
      maxTarget,
      minExtranonceSize: 8,
    };
    const result = roundTrip(msg, serializeOpenExtendedMiningChannel, deserializeOpenExtendedMiningChannel);
    expect(result.requestId).toBe(msg.requestId);
    expect(result.userIdentity).toBe(msg.userIdentity);
    expect(result.nominalHashRate).toBeCloseTo(msg.nominalHashRate, 0);
    expect(result.maxTarget).toEqual(msg.maxTarget);
    expect(result.minExtranonceSize).toBe(msg.minExtranonceSize);
  });

  it('OpenExtendedMiningChannelSuccess round-trips', () => {
    const target = Buffer.alloc(32);
    target[0] = 0xff;
    const msg: Sv2OpenExtendedMiningChannelSuccess = {
      requestId: 1,
      channelId: 42,
      target,
      extranonceSize: 8,
      extranoncePrefix: Buffer.from([0x00, 0x00, 0x00, 0x01]),
      groupChannelId: 0,
    };
    const result = roundTrip(
      msg,
      serializeOpenExtendedMiningChannelSuccess,
      deserializeOpenExtendedMiningChannelSuccess,
    );
    expect(result.requestId).toBe(msg.requestId);
    expect(result.channelId).toBe(msg.channelId);
    expect(result.target).toEqual(msg.target);
    expect(result.extranonceSize).toBe(msg.extranonceSize);
    expect(result.extranoncePrefix).toEqual(msg.extranoncePrefix);
    expect(result.groupChannelId).toBe(msg.groupChannelId);
  });

  it('NewExtendedMiningJob round-trips with minNtime (mine immediately)', () => {
    const hash1 = Buffer.alloc(32, 0xaa);
    const hash2 = Buffer.alloc(32, 0xbb);
    const msg: Sv2NewExtendedMiningJob = {
      channelId: 1,
      jobId: 100,
      minNtime: 1700000000,
      version: 0x20000000,
      versionRollingAllowed: true,
      merklePath: [hash1, hash2],
      coinbasePrefix: Buffer.from('deadbeef', 'hex'),
      coinbaseSuffix: Buffer.from('cafebabe', 'hex'),
    };
    const result = roundTrip(msg, serializeNewExtendedMiningJob, deserializeNewExtendedMiningJob);
    expect(result.channelId).toBe(msg.channelId);
    expect(result.jobId).toBe(msg.jobId);
    expect(result.minNtime).toBe(msg.minNtime);
    expect(result.version).toBe(msg.version);
    expect(result.versionRollingAllowed).toBe(msg.versionRollingAllowed);
    expect(result.merklePath).toHaveLength(2);
    expect(result.merklePath[0]).toEqual(hash1);
    expect(result.merklePath[1]).toEqual(hash2);
    expect(result.coinbasePrefix).toEqual(msg.coinbasePrefix);
    expect(result.coinbaseSuffix).toEqual(msg.coinbaseSuffix);
  });

  it('NewExtendedMiningJob with null minNtime (future job)', () => {
    const msg: Sv2NewExtendedMiningJob = {
      channelId: 1,
      jobId: 1,
      minNtime: null,
      version: 0x20000000,
      versionRollingAllowed: false,
      merklePath: [],
      coinbasePrefix: Buffer.alloc(0),
      coinbaseSuffix: Buffer.alloc(0),
    };
    const result = roundTrip(msg, serializeNewExtendedMiningJob, deserializeNewExtendedMiningJob);
    expect(result.merklePath).toHaveLength(0);
    expect(result.minNtime).toBeNull();
    expect(result.versionRollingAllowed).toBe(false);
  });

  it('SubmitSharesExtended round-trips', () => {
    const msg: Sv2SubmitSharesExtended = {
      channelId: 1,
      sequenceNumber: 42,
      jobId: 100,
      nonce: 0xdeadbeef,
      ntime: 1700000000,
      version: 0x20000000,
      extranonce: Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]),
    };
    const result = roundTrip(msg, serializeSubmitSharesExtended, deserializeSubmitSharesExtended);
    expect(result.channelId).toBe(msg.channelId);
    expect(result.sequenceNumber).toBe(msg.sequenceNumber);
    expect(result.jobId).toBe(msg.jobId);
    expect(result.nonce).toBe(msg.nonce);
    expect(result.ntime).toBe(msg.ntime);
    expect(result.version).toBe(msg.version);
    expect(result.extranonce).toEqual(msg.extranonce);
  });

  it('SubmitSharesExtended with short extranonce', () => {
    const msg: Sv2SubmitSharesExtended = {
      channelId: 1,
      sequenceNumber: 1,
      jobId: 1,
      nonce: 0,
      ntime: 1700000000,
      version: 0x20000000,
      extranonce: Buffer.from([0xab]),
    };
    const result = roundTrip(msg, serializeSubmitSharesExtended, deserializeSubmitSharesExtended);
    expect(result.extranonce).toEqual(Buffer.from([0xab]));
  });

  it('SetExtranoncePrefix round-trips', () => {
    const msg: Sv2SetExtranoncePrefix = {
      channelId: 5,
      extranoncePrefix: Buffer.from([0x00, 0x00, 0x00, 0x02]),
    };
    const result = roundTrip(msg, serializeSetExtranoncePrefix, deserializeSetExtranoncePrefix);
    expect(result.channelId).toBe(msg.channelId);
    expect(result.extranoncePrefix).toEqual(msg.extranoncePrefix);
  });

  it('SetGroupChannel round-trips', () => {
    const msg: Sv2SetGroupChannel = {
      groupChannelId: 10,
      channelIds: [42, 43, 44],
    };
    const result = roundTrip(msg, serializeSetGroupChannel, deserializeSetGroupChannel);
    expect(result).toEqual(msg);
  });

  it('serialized SubmitSharesExtended has correct byte layout', () => {
    const msg: Sv2SubmitSharesExtended = {
      channelId: 1,
      sequenceNumber: 2,
      jobId: 3,
      nonce: 4,
      ntime: 5,
      version: 6,
      extranonce: Buffer.from([0xab, 0xcd]),
    };
    const buf = serializeSubmitSharesExtended(msg);
    // 6 * U32(4) = 24 + B0_32(1+2) = 27
    expect(buf.length).toBe(27);
    expect(buf.readUInt32LE(0)).toBe(1);
    expect(buf.readUInt32LE(4)).toBe(2);
    expect(buf.readUInt32LE(8)).toBe(3);
  });
});
