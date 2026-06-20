import { normalizePayoutMode, parsePayoutModePorts } from './payout-mode';

describe('payout mode helpers', () => {
    it('maps legacy ports to solo and PPLNS ports to pplns', () => {
        expect(parsePayoutModePorts('3333,3332', '13333')).toEqual([
            { port: 3333, payoutMode: 'solo' },
            { port: 3332, payoutMode: 'solo' },
            { port: 13333, payoutMode: 'pplns' },
        ]);
    });

    it('rejects a port configured for both payout modes', () => {
        expect(() => parsePayoutModePorts('3333', '3333'))
            .toThrow('Port 3333 is configured for both solo and pplns payout modes');
    });

    it('normalizes unknown mode values to solo', () => {
        expect(normalizePayoutMode('pplns')).toBe('pplns');
        expect(normalizePayoutMode('pool')).toBe('solo');
        expect(normalizePayoutMode(undefined)).toBe('solo');
    });
});
