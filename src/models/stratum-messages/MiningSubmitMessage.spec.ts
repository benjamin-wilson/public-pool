import { plainToInstance } from 'class-transformer';

import { MiningSubmitMessage } from './MiningSubmitMessage';

describe('MiningSubmitMessage', () => {
  beforeEach(async () => {});

  describe('test message parsing', () => {
    const MINING_SUBMIT_MESSAGE =
      ' {"id": 5, "method": "mining.submit", "params": ["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3", "1", "99020000", "64b1f10f", "2402812d", "00006000"]}';

    const message = plainToInstance(
      MiningSubmitMessage,
      JSON.parse(MINING_SUBMIT_MESSAGE),
    );

    it('should parse message', () => {
      expect(message.id).toEqual(5);
      expect(message.userId).toEqual(
        'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3',
      );
      expect(message.jobId).toEqual('1');
      expect(message.extraNonce2).toEqual('99020000');
      expect(message.ntime).toEqual('64b1f10f');
      expect(message.nonce).toEqual('2402812d');
      expect(message.versionMask).toEqual('00006000');
    });
  });
});
