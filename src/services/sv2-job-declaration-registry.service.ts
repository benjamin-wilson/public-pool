import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

import { Sv2DeclareMiningJob } from '../models/sv2/sv2-jdp-messages';
import { TemplateProviderTemplate } from './template-provider.service';

export interface Sv2AllocatedMiningJobToken {
    token: Buffer;
    userIdentifier: string;
    coinbaseOutputs: Buffer;
    createdAt: number;
}

export interface Sv2DeclaredMiningJob {
    originalToken: Buffer;
    token: Buffer;
    userIdentifier: string;
    job: Sv2DeclareMiningJob;
    createdAt: number;
    templateId?: bigint;
    template?: TemplateProviderTemplate;
    validationMode: 'token_only' | 'full_template';
    providedTransactions: Buffer[];
}

@Injectable()
export class Sv2JobDeclarationRegistryService {
    private readonly allocatedTokens = new Map<string, Sv2AllocatedMiningJobToken>();
    private readonly declaredJobs = new Map<string, Sv2DeclaredMiningJob>();
    private readonly tokenTtlMs = this.readPositiveInt('SV2_JDP_TOKEN_TTL_MS', 10 * 60 * 1000);

    public allocateToken(userIdentifier: string, coinbaseOutputs: Buffer): Sv2AllocatedMiningJobToken {
        this.cleanup();
        const token = crypto.randomBytes(16);
        const entry = {
            token,
            userIdentifier,
            coinbaseOutputs: Buffer.from(coinbaseOutputs),
            createdAt: Date.now(),
        };
        this.allocatedTokens.set(token.toString('hex'), entry);
        return entry;
    }

    public declareJob(job: Sv2DeclareMiningJob, metadata: {
        templateId?: bigint;
        template?: TemplateProviderTemplate;
        validationMode?: 'token_only' | 'full_template';
        providedTransactions?: Buffer[];
    } = {}): Sv2DeclaredMiningJob {
        this.cleanup();
        const originalTokenHex = job.miningJobToken.toString('hex');
        const allocated = this.allocatedTokens.get(originalTokenHex);
        if (allocated == null) {
            throw new Error('invalid-mining-job-token');
        }
        if (!this.coinbaseIncludesRequiredOutputs(job, allocated.coinbaseOutputs)) {
            throw new Error('coinbase-output-mismatch');
        }
        const token = crypto.randomBytes(16);
        const declared = {
            originalToken: Buffer.from(job.miningJobToken),
            token,
            userIdentifier: allocated.userIdentifier,
            job,
            createdAt: Date.now(),
            templateId: metadata.templateId,
            template: metadata.template,
            validationMode: metadata.validationMode ?? 'token_only',
            providedTransactions: (metadata.providedTransactions ?? []).map(tx => Buffer.from(tx)),
        };
        this.declaredJobs.set(token.toString('hex'), declared);
        return declared;
    }

    public hasKnownToken(token: Buffer): boolean {
        this.cleanup();
        const tokenHex = token.toString('hex');
        return this.allocatedTokens.has(tokenHex) || this.declaredJobs.has(tokenHex);
    }

    public getDeclaredJob(token: Buffer): Sv2DeclaredMiningJob | undefined {
        this.cleanup();
        return this.declaredJobs.get(token.toString('hex'));
    }

    private cleanup(): void {
        const cutoff = Date.now() - this.tokenTtlMs;
        for (const [token, entry] of this.allocatedTokens.entries()) {
            if (entry.createdAt < cutoff) {
                this.allocatedTokens.delete(token);
            }
        }
        for (const [token, entry] of this.declaredJobs.entries()) {
            if (entry.createdAt < cutoff) {
                this.declaredJobs.delete(token);
            }
        }
    }

    private coinbaseIncludesRequiredOutputs(job: Sv2DeclareMiningJob, coinbaseOutputs: Buffer): boolean {
        if (coinbaseOutputs.length === 0) {
            return true;
        }
        const declaredCoinbase = Buffer.concat([job.coinbaseTxPrefix, job.coinbaseTxSuffix]);
        for (const script of this.extractOutputScripts(coinbaseOutputs)) {
            if (script.length === 0 || declaredCoinbase.indexOf(script) < 0) {
                return false;
            }
        }
        return true;
    }

    private extractOutputScripts(outputs: Buffer): Buffer[] {
        const { value: outputCount, offset } = this.readVarInt(outputs, 0);
        const scripts: Buffer[] = [];
        let cursor = offset;
        for (let i = 0; i < outputCount; i++) {
            if (cursor + 8 > outputs.length) {
                throw new Error('invalid-coinbase-outputs');
            }
            cursor += 8;
            const scriptLength = this.readVarInt(outputs, cursor);
            cursor = scriptLength.offset;
            if (cursor + scriptLength.value > outputs.length) {
                throw new Error('invalid-coinbase-outputs');
            }
            scripts.push(Buffer.from(outputs.subarray(cursor, cursor + scriptLength.value)));
            cursor += scriptLength.value;
        }
        return scripts;
    }

    private readVarInt(buffer: Buffer, offset: number): { value: number; offset: number } {
        if (offset >= buffer.length) {
            throw new Error('invalid-coinbase-outputs');
        }
        const first = buffer[offset];
        if (first < 0xfd) {
            return { value: first, offset: offset + 1 };
        }
        if (first === 0xfd) {
            if (offset + 3 > buffer.length) {
                throw new Error('invalid-coinbase-outputs');
            }
            return { value: buffer.readUInt16LE(offset + 1), offset: offset + 3 };
        }
        if (first === 0xfe) {
            if (offset + 5 > buffer.length) {
                throw new Error('invalid-coinbase-outputs');
            }
            return { value: buffer.readUInt32LE(offset + 1), offset: offset + 5 };
        }
        throw new Error('unsupported-large-coinbase-output-count');
    }

    private readPositiveInt(name: string, fallback: number): number {
        const parsed = parseInt(process.env[name] ?? '', 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }
}
