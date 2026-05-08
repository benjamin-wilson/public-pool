import { plainToInstance } from 'class-transformer';

import { SubscriptionMessage } from './SubscriptionMessage';

describe('SubscriptionMessage', () => {
    it('should parse and refine known user agents', () => {
        const bosminer = plainToInstance(
            SubscriptionMessage,
            JSON.parse('{"id":1,"method":"mining.subscribe","params":["bosminer/23.08"]}')
        );
        const cpuminer = plainToInstance(
            SubscriptionMessage,
            JSON.parse('{"id":1,"method":"mining.subscribe","params":["cpuminer-opt/1.0"]}')
        );

        expect(bosminer.userAgent).toBe('Braiins OS');
        expect(cpuminer.userAgent).toBe('cpuminer');
    });

    it('should default missing user agents to unknown', () => {
        const message = plainToInstance(
            SubscriptionMessage,
            JSON.parse('{"id":1,"method":"mining.subscribe","params":[]}')
        );

        expect(message.userAgent).toBe('unknown');
    });

    it('should respond with extranonce2 size of 8 bytes', () => {
        const message = plainToInstance(
            SubscriptionMessage,
            JSON.parse('{"id":1,"method":"mining.subscribe","params":["bitaxe v2.2"]}')
        );

        expect(message.response('57a6f098')).toEqual({
            id: 1,
            error: null,
            result: [
                [['mining.notify', '57a6f098']],
                '57a6f098',
                8
            ]
        });
    });
});
