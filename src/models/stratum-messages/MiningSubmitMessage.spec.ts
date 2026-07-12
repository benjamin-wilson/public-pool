import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { MiningSubmitMessage } from './MiningSubmitMessage';

describe('MiningSubmitMessage', () => {


    beforeEach(async () => {



    });

    describe('test message parsing', () => {

        const MINING_SUBMIT_MESSAGE = ' {"id": 5, "method": "mining.submit", "params": ["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3", "1", "9902000000000000", "64b1f10f", "2402812d", "00006000"]}'

        const message = plainToInstance(
            MiningSubmitMessage,
            JSON.parse(MINING_SUBMIT_MESSAGE),
        );

        it('should parse message', () => {
            expect(message.id).toEqual(5);
            expect(message.userId).toEqual('tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3');
            expect(message.jobId).toEqual('1');
            expect(message.extraNonce2).toEqual('9902000000000000');
            expect(message.ntime).toEqual('64b1f10f');
            expect(message.nonce).toEqual('2402812d');
            expect(message.versionMask).toEqual('00006000');
        });

        it('should validate 8-byte extranonce2 submissions', async () => {
            const errors = await validate(message);

            expect(errors).toEqual([]);
        });

        it('should hash submissions deterministically', () => {
            expect(message.hash()).toBe('t2bFzhZ6mketRxa5nOoKrNxG3RkFIZuOwY1WewFtv9k=');
        });

        it('should reject short extranonce2 submissions', async () => {
            const shortMessage = plainToInstance(
                MiningSubmitMessage,
                JSON.parse(' {"id": 5, "method": "mining.submit", "params": ["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3", "1", "99020000", "64b1f10f", "2402812d", "00006000"]}'),
            );

            const errors = await validate(shortMessage);

            expect(errors.some(error => error.property === 'extraNonce2')).toBe(true);
        });

        it('should reject long extranonce2 submissions', async () => {
            const longMessage = plainToInstance(
                MiningSubmitMessage,
                JSON.parse(' {"id": 5, "method": "mining.submit", "params": ["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3", "1", "990200000000000000", "64b1f10f", "2402812d", "00006000"]}'),
            );

            const errors = await validate(longMessage);

            expect(errors.some(error => error.property === 'extraNonce2')).toBe(true);
        });

        it.each([
            { field: 'extraNonce2', index: 2, value: '990200000000000g' },
            { field: 'ntime', index: 3, value: '64b1f10ftrailing' },
            { field: 'nonce', index: 4, value: '2402812g' },
            { field: 'versionMask', index: 5, value: '00006000trailing' },
        ])('should reject a non-canonical hexadecimal $field', async ({ field, index, value }) => {
            const parsed = JSON.parse(MINING_SUBMIT_MESSAGE);
            parsed.params[index] = value;
            const invalidMessage = plainToInstance(MiningSubmitMessage, parsed);

            const errors = await validate(invalidMessage);

            expect(errors.some(error => error.property === field)).toBe(true);
        });

        it('should normalize an omitted version mask to eight zeroes', async () => {
            const parsed = JSON.parse(MINING_SUBMIT_MESSAGE);
            parsed.params.pop();
            const noVersionMask = plainToInstance(MiningSubmitMessage, parsed);

            expect(noVersionMask.versionMask).toBe('00000000');
            await expect(validate(noVersionMask)).resolves.toEqual([]);
        });
    });


});
