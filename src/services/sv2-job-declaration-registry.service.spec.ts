import { Sv2JobDeclarationRegistryService } from './sv2-job-declaration-registry.service';

describe('Sv2JobDeclarationRegistryService', () => {
    it('tracks allocated and declared custom work tokens', () => {
        const registry = new Sv2JobDeclarationRegistryService();
        const coinbaseOutputs = Buffer.from('010000000000000000016a', 'hex');
        const allocated = registry.allocateToken('bc1ptest.worker', coinbaseOutputs);

        expect(registry.hasKnownToken(allocated.token)).toBe(true);
        expect(allocated.coinbaseOutputs).toEqual(coinbaseOutputs);
        expect(allocated.coinbaseOutputs).not.toBe(coinbaseOutputs);

        const declared = registry.declareJob({
            requestId: 7,
            miningJobToken: allocated.token,
            version: 0x20000000,
            coinbaseTxPrefix: Buffer.concat([Buffer.from('51', 'hex'), Buffer.from('6a', 'hex')]),
            coinbaseTxSuffix: Buffer.from('52', 'hex'),
            wtxidList: [],
            excessData: Buffer.alloc(0),
        });

        expect(registry.hasKnownToken(declared.token)).toBe(true);
        expect(registry.getDeclaredJob(declared.token)).toBe(declared);
        expect(declared.originalToken).toEqual(allocated.token);
        expect(declared.userIdentifier).toBe('bc1ptest.worker');
    });

    it('rejects declared jobs that omit allocated coinbase output scripts', () => {
        const registry = new Sv2JobDeclarationRegistryService();
        const coinbaseOutputs = Buffer.from('010000000000000000016a', 'hex');
        const allocated = registry.allocateToken('bc1ptest.worker', coinbaseOutputs);

        expect(() => registry.declareJob({
            requestId: 7,
            miningJobToken: allocated.token,
            version: 0x20000000,
            coinbaseTxPrefix: Buffer.from('51', 'hex'),
            coinbaseTxSuffix: Buffer.from('52', 'hex'),
            wtxidList: [],
            excessData: Buffer.alloc(0),
        })).toThrow('coinbase-output-mismatch');
    });

    it('rejects declarations using unknown mining job tokens', () => {
        const registry = new Sv2JobDeclarationRegistryService();

        expect(() => registry.declareJob({
            requestId: 8,
            miningJobToken: Buffer.from('00', 'hex'),
            version: 0x20000000,
            coinbaseTxPrefix: Buffer.alloc(0),
            coinbaseTxSuffix: Buffer.alloc(0),
            wtxidList: [],
            excessData: Buffer.alloc(0),
        })).toThrow('invalid-mining-job-token');
    });
});
