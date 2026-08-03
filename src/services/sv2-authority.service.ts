import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

import { encodeSv2AuthorityPublicKey } from '../models/sv2/sv2-authority-key';
import { xOnlyPubKeyFromPriv } from '../models/sv2/sv2-noise';

@Injectable()
export class Sv2AuthorityService {
    private authorityPublicKey: string | null = null;
    private authorityKeyConfigured = false;

    constructor(
        private readonly configService: ConfigService,
    ) {}

    public async getPoolAuthorityPublicKey(): Promise<{ publicKey: string; configured: boolean }> {
        if (this.authorityPublicKey != null) {
            return {
                publicKey: this.authorityPublicKey,
                configured: this.authorityKeyConfigured,
            };
        }

        const configuredAuthorityKey = this.configService.get<string>('SV2_AUTHORITY_PRIVKEY');
        this.authorityKeyConfigured = configuredAuthorityKey?.length === 64;
        const authorityPrivKey = configuredAuthorityKey?.length === 64
            ? Buffer.from(configuredAuthorityKey, 'hex')
            : crypto.randomBytes(32);
        this.authorityPublicKey = encodeSv2AuthorityPublicKey(xOnlyPubKeyFromPriv(authorityPrivKey));

        return {
            publicKey: this.authorityPublicKey,
            configured: this.authorityKeyConfigured,
        };
    }
}
