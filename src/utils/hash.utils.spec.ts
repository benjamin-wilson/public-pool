import * as crypto from 'crypto';

import { hash256 } from './hash.utils';

describe('hash256', () => {
    it('matches native double sha256 for known input', () => {
        const data = Buffer.from('public-pool-share-validation', 'utf8');
        const expected = crypto
            .createHash('sha256')
            .update(crypto.createHash('sha256').update(data).digest())
            .digest('hex');

        expect(hash256(data).toString('hex')).toBe(expected);
    });
});
