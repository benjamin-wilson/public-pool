import { TOTAL_EXTRANONCE_SIZE_BYTES } from '../models/stratum.constants';

export function patchCoinbasePrefixVarint(prefix: Buffer, totalExtranonceSize: number): Buffer {
    if (totalExtranonceSize === TOTAL_EXTRANONCE_SIZE_BYTES) {
        return prefix;
    }
    if (prefix.length < 42) {
        return prefix;
    }

    const patched = Buffer.from(prefix);
    const nextLength = patched[41] + (totalExtranonceSize - TOTAL_EXTRANONCE_SIZE_BYTES);
    if (nextLength < 0 || nextLength > 0xfc) {
        return prefix;
    }

    patched[41] = nextLength;
    return patched;
}
