import { BufferReader } from './sv2-binary-codec';
import {
  Sv2SetupConnection, serializeSetupConnection, deserializeSetupConnection,
  Sv2SetupConnectionSuccess, serializeSetupConnectionSuccess, deserializeSetupConnectionSuccess,
  Sv2SetupConnectionError, serializeSetupConnectionError, deserializeSetupConnectionError,
  Sv2ChannelEndpointChanged, serializeChannelEndpointChanged, deserializeChannelEndpointChanged,
  Sv2OpenStandardMiningChannel, serializeOpenStandardMiningChannel, deserializeOpenStandardMiningChannel,
  Sv2OpenStandardMiningChannelSuccess, serializeOpenStandardMiningChannelSuccess, deserializeOpenStandardMiningChannelSuccess,
  Sv2NewMiningJob, serializeNewMiningJob, deserializeNewMiningJob,
  Sv2SetNewPrevHash, serializeSetNewPrevHash, deserializeSetNewPrevHash,
  Sv2SetTarget, serializeSetTarget, deserializeSetTarget,
  Sv2SubmitSharesStandard, serializeSubmitSharesStandard, deserializeSubmitSharesStandard,
  Sv2SubmitSharesSuccess, serializeSubmitSharesSuccess, deserializeSubmitSharesSuccess,
  Sv2SubmitSharesError, serializeSubmitSharesError, deserializeSubmitSharesError,
  Sv2CloseChannel, serializeCloseChannel, deserializeCloseChannel,
  Sv2UpdateChannel, serializeUpdateChannel, deserializeUpdateChannel,
  Sv2UpdateChannelError, serializeUpdateChannelError, deserializeUpdateChannelError,
  Sv2Reconnect, serializeReconnect, deserializeReconnect,
} from './sv2-messages';

function roundTrip<T>(
  msg: T,
  serialize: (m: T) => Buffer,
  deserialize: (r: BufferReader) => T,
): T {
  const buf = serialize(msg);
  return deserialize(new BufferReader(buf));
}

describe('SV2 Messages', () => {
  it('SetupConnection round-trips', () => {
    const msg: Sv2SetupConnection = {
      protocol: 0,
      minVersion: 2,
      maxVersion: 2,
      flags: 0x07,
      endpoint_host: 'pool.example.com',
      endpoint_port: 3333,
      vendor: 'TestMiner',
      hardwareVersion: '1.0',
      firmwareVersion: '2.1',
      deviceId: 'device-001',
    };
    const result = roundTrip(msg, serializeSetupConnection, deserializeSetupConnection);
    expect(result).toEqual(msg);
  });

  it('SetupConnectionSuccess round-trips', () => {
    const msg: Sv2SetupConnectionSuccess = {
      usedVersion: 2,
      flags: 0x05,
    };
    const result = roundTrip(msg, serializeSetupConnectionSuccess, deserializeSetupConnectionSuccess);
    expect(result).toEqual(msg);
  });

  it('SetupConnectionError round-trips', () => {
    const msg: Sv2SetupConnectionError = {
      flags: 0x00,
      errorCode: 'unsupported-feature-flags',
    };
    const result = roundTrip(msg, serializeSetupConnectionError, deserializeSetupConnectionError);
    expect(result).toEqual(msg);
  });

  it('ChannelEndpointChanged round-trips', () => {
    const msg: Sv2ChannelEndpointChanged = {
      channelId: 7,
    };
    const result = roundTrip(msg, serializeChannelEndpointChanged, deserializeChannelEndpointChanged);
    expect(result).toEqual(msg);
  });

  it('OpenStandardMiningChannel round-trips', () => {
    const maxTarget = Buffer.alloc(32, 0x00);
    maxTarget[0] = 0xff;
    maxTarget[28] = 0x1d;
    const msg: Sv2OpenStandardMiningChannel = {
      requestId: 1,
      user_identity: 'worker1',
      nominalHashRate: 1000000.0,
      maxTarget,
    };
    const result = roundTrip(msg, serializeOpenStandardMiningChannel, deserializeOpenStandardMiningChannel);
    expect(result.requestId).toBe(msg.requestId);
    expect(result.user_identity).toBe(msg.user_identity);
    expect(result.nominalHashRate).toBeCloseTo(msg.nominalHashRate, 0);
    expect(result.maxTarget).toEqual(msg.maxTarget);
  });

  it('OpenStandardMiningChannelSuccess round-trips', () => {
    const target = Buffer.alloc(32);
    target[0] = 0xff;
    target[31] = 0x01;
    const msg: Sv2OpenStandardMiningChannelSuccess = {
      requestId: 1,
      channelId: 42,
      target,
      extranonce_prefix: Buffer.from([0x01, 0x02, 0x03]),
      groupChannelId: 0,
    };
    const result = roundTrip(
      msg,
      serializeOpenStandardMiningChannelSuccess,
      deserializeOpenStandardMiningChannelSuccess,
    );
    expect(result.requestId).toBe(msg.requestId);
    expect(result.channelId).toBe(msg.channelId);
    expect(result.target).toEqual(msg.target);
    expect(result.extranonce_prefix).toEqual(msg.extranonce_prefix);
    expect(result.groupChannelId).toBe(msg.groupChannelId);
  });

  it('NewMiningJob round-trips', () => {
    const merkleRoot = Buffer.alloc(32, 0xab);
    const msg: Sv2NewMiningJob = {
      channelId: 1,
      jobId: 100,
      minNtime: null, // Sv2Option<U32>: null = future job
      version: 0x20000000,
      merkleRoot,
    };
    const result = roundTrip(msg, serializeNewMiningJob, deserializeNewMiningJob);
    expect(result).toEqual(msg);
  });

  it('NewMiningJob round-trips with minNtime value', () => {
    const merkleRoot = Buffer.alloc(32, 0xab);
    const msg: Sv2NewMiningJob = {
      channelId: 1,
      jobId: 101,
      minNtime: 1700000000, // Sv2Option<U32>: Some(timestamp) = ready to mine
      version: 0x20000000,
      merkleRoot,
    };
    const result = roundTrip(msg, serializeNewMiningJob, deserializeNewMiningJob);
    expect(result).toEqual(msg);
  });

  it('SetNewPrevHash round-trips', () => {
    const prevHash = Buffer.alloc(32, 0xcd);
    const msg: Sv2SetNewPrevHash = {
      channelId: 1,
      jobId: 100,
      prevHash,
      minNtime: 1700000000,
      nBits: 0x1d00ffff,
    };
    const result = roundTrip(msg, serializeSetNewPrevHash, deserializeSetNewPrevHash);
    expect(result).toEqual(msg);
  });

  it('SetTarget round-trips', () => {
    const maxTarget = Buffer.alloc(32, 0x00);
    maxTarget[0] = 0xff;
    const msg: Sv2SetTarget = {
      channelId: 5,
      maxTarget,
    };
    const result = roundTrip(msg, serializeSetTarget, deserializeSetTarget);
    expect(result).toEqual(msg);
  });

  it('SubmitSharesStandard round-trips', () => {
    const msg: Sv2SubmitSharesStandard = {
      channelId: 1,
      sequenceNumber: 42,
      jobId: 100,
      nonce: 0xdeadbeef,
      ntime: 1700000000,
      version: 0x20000000,
    };
    const result = roundTrip(msg, serializeSubmitSharesStandard, deserializeSubmitSharesStandard);
    expect(result).toEqual(msg);
  });

  it('SubmitSharesSuccess round-trips', () => {
    const msg: Sv2SubmitSharesSuccess = {
      channelId: 1,
      lastSequenceNumber: 42,
      newSubmitsAcceptedCount: 10,
      newSharesSum: 123456789012345n,
    };
    const result = roundTrip(msg, serializeSubmitSharesSuccess, deserializeSubmitSharesSuccess);
    expect(result).toEqual(msg);
  });

  it('SubmitSharesError round-trips', () => {
    const msg: Sv2SubmitSharesError = {
      channelId: 1,
      sequenceNumber: 42,
      errorCode: 'stale-share',
    };
    const result = roundTrip(msg, serializeSubmitSharesError, deserializeSubmitSharesError);
    expect(result).toEqual(msg);
  });

  it('CloseChannel round-trips', () => {
    const msg: Sv2CloseChannel = {
      channelId: 7,
      reasonCode: 'client-disconnect',
    };
    const result = roundTrip(msg, serializeCloseChannel, deserializeCloseChannel);
    expect(result).toEqual(msg);
  });

  it('UpdateChannel round-trips', () => {
    const maximumTarget = Buffer.alloc(32, 0x00);
    maximumTarget[0] = 0xff;
    const msg: Sv2UpdateChannel = {
      channelId: 3,
      nominalHashRate: 500000.0,
      maximumTarget,
    };
    const result = roundTrip(msg, serializeUpdateChannel, deserializeUpdateChannel);
    expect(result.channelId).toBe(msg.channelId);
    expect(result.nominalHashRate).toBeCloseTo(msg.nominalHashRate, 0);
    expect(result.maximumTarget).toEqual(msg.maximumTarget);
  });

  it('UpdateChannelError round-trips', () => {
    const msg: Sv2UpdateChannelError = {
      channelId: 3,
      errorCode: 'invalid-channel',
    };
    const result = roundTrip(msg, serializeUpdateChannelError, deserializeUpdateChannelError);
    expect(result).toEqual(msg);
  });

  it('Reconnect round-trips', () => {
    const msg: Sv2Reconnect = {
      newHost: 'pool2.example.com',
      newPort: 3334,
    };
    const result = roundTrip(msg, serializeReconnect, deserializeReconnect);
    expect(result).toEqual(msg);
  });

  it('serialized bytes match expected layout (SetupConnectionSuccess)', () => {
    const msg: Sv2SetupConnectionSuccess = {
      usedVersion: 2,
      flags: 0x01,
    };
    const buf = serializeSetupConnectionSuccess(msg);
    // U16 LE(2) + U32 LE(1) = 6 bytes
    expect(buf.length).toBe(6);
    expect(buf.readUInt16LE(0)).toBe(2);
    expect(buf.readUInt32LE(2)).toBe(1);
  });
});
