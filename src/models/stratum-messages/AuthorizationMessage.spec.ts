import { plainToInstance } from 'class-transformer';

import { AuthorizationMessage } from './AuthorizationMessage';

describe('AuthorizationMessage', () => {
    it('should parse address, worker, and starting difficulty', () => {
        const message = plainToInstance(
            AuthorizationMessage,
            JSON.parse('{"id":3,"method":"mining.authorize","params":["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker1","x,d=2048"]}')
        );

        expect(message.address).toBe('tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4');
        expect(message.worker).toBe('worker1');
        expect(message.password).toBe('x,d=2048');
        expect(message.startingDiff).toBe(2048);
    });

    it('should default worker name when one is not provided', () => {
        const message = plainToInstance(
            AuthorizationMessage,
            JSON.parse('{"id":3,"method":"mining.authorize","params":["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4","x"]}')
        );

        expect(message.worker).toBe('worker');
        expect(message.startingDiff).toBeNull();
    });

    it('should ignore malformed starting difficulty hints', () => {
        const message = plainToInstance(
            AuthorizationMessage,
            JSON.parse('{"id":3,"method":"mining.authorize","params":["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker1","x,d=abc"]}')
        );

        expect(message.startingDiff).toBeNull();
    });

    it('should build successful authorization responses', () => {
        const message = plainToInstance(
            AuthorizationMessage,
            JSON.parse('{"id":3,"method":"mining.authorize","params":["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.worker1","x"]}')
        );

        expect(message.response()).toEqual({
            id: 3,
            error: null,
            result: true
        });
    });
});
