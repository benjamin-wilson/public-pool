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

    it('should parse a Braiins OS user agent that starts with a build date', () => {
        const message = plainToInstance(
            SubscriptionMessage,
            JSON.parse('{"id":1,"method":"mining.subscribe","params":["2026-10-19-0-46be68fe-26.10-plus;bosminer-plus-tuner 0.9.0-46be68fe",null,"192.168.1.24:3333",null]}')
        );

        expect(message.userAgent).toBe('Braiins OS');
    });

    it.each([
        // Known miners are matched anywhere in the string.
        ['bOS+ 23.08', 'Braiins OS'],
        ['2026-10-19-0-46be68fe-26.10-plus;bosminer-plus-tuner 0.9.0-46be68fe', 'Braiins OS'],
        ['sgminer cpuminer-multi/1.3', 'cpuminer'],
        // Other user agents are still shortened as before.
        ['bitaxe/BM1370/v2.9.0', 'bitaxe'],
        ['bitaxe v2.2', 'bitaxe'],
        ['NerdMinerV2', 'NerdMiner'],
        // Never a bare date, a version number, or an empty name.
        ['2026-01-01-0-abc;someminer 1.0', '2026-01-01-0-abc'],
        ['1.2.3', '1.2.3'],
        ['Vnish/1.2', 'Vnish'],
        ['', ''],
    ])('should refine %p to %p', (userAgent, expected) => {
        expect(SubscriptionMessage.refineUserAgent(userAgent)).toBe(expected);
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
