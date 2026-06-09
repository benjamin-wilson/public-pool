import * as crypto from 'crypto';

export function hash256(data: Buffer): Buffer {
    const first = crypto.createHash('sha256').update(data).digest();
    return crypto.createHash('sha256').update(first).digest();
}
