import { Injectable, OnModuleInit } from '@nestjs/common';
import * as bitcoinjs from 'bitcoinjs-lib';
import { Subscription } from 'rxjs';

import { IBlockTemplateTx } from '../models/bitcoin-rpc/IBlockTemplate';
import { AddressObject } from '../models/MiningJob';
import { Sv2DeclareMiningJob, Sv2PushSolution } from '../models/sv2/sv2-jdp-messages';
import { hash256 } from '../utils/hash.utils';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { IJobTemplate, StratumV1JobsService } from './stratum-v1-jobs.service';

export interface TemplateProviderTransaction {
    position: number;
    data: Buffer;
    txid: string;
    wtxid: string;
    fee: number;
    sigops: number;
    weight: number;
}

export interface TemplateProviderTemplate {
    templateId: bigint;
    jobTemplate: IJobTemplate;
    version: number;
    prevHash: Buffer;
    nBits: number;
    minNtime: number;
    coinbaseValue: bigint;
    networkDifficulty: number;
    target: Buffer;
    height: number;
    sigopLimit: number;
    sizeLimit: number;
    weightLimit: number;
    transactions: TemplateProviderTransaction[];
    transactionList: Buffer[];
    txidMap: Map<string, TemplateProviderTransaction>;
    wtxidMap: Map<string, TemplateProviderTransaction>;
    createdAt: number;
}

export interface DeclareMiningJobValidationResult {
    valid: boolean;
    errorCode?: string;
    template?: TemplateProviderTemplate;
    unknownTxPositionList?: number[];
}

export interface DatumTemplateValidationInput {
    prevBlockHash?: Buffer;
    nBits?: Buffer;
    height?: number;
    version?: number;
    coinbaseValue?: bigint;
    totalWeight?: number;
    totalSize?: number;
    totalSigops?: number;
    merkleBranches?: Buffer[];
}

export interface TemplateFastPathValidationResult {
    valid: boolean;
    errorCode?: string;
    template?: TemplateProviderTemplate;
}

export interface TransactionDataValidationResult {
    valid: boolean;
    errorCode?: string;
    transactions?: TemplateProviderTransaction[];
    totalBytes?: number;
}

export interface CoinbaseHeightValidationResult {
    valid: boolean;
    errorCode?: string;
}

export interface CoinbasePayoutOutput {
    value: bigint;
    scriptPubKey: Buffer;
}

export interface CoinbasePayoutValidationResult {
    valid: boolean;
    errorCode?: string;
    expectedOutputs?: CoinbasePayoutOutput[];
    submittedOutputs?: CoinbasePayoutOutput[];
}

const VERSION_ROLLING_MASK = 0x1fffe000;

@Injectable()
export class TemplateProviderService implements OnModuleInit {
    private readonly templates = new Map<string, TemplateProviderTemplate>();
    private readonly retentionMs = this.readPositiveInt('SV2_TEMPLATE_RETENTION_MS', 10 * 60 * 1000);
    private subscription: Subscription | null = null;
    private latestTemplateId: string | null = null;

    constructor(
        private readonly jobsService: StratumV1JobsService,
        private readonly bitcoinRpcService?: BitcoinRpcService,
    ) {}

    public onModuleInit(): void {
        if (this.subscription != null || process.env.API_ONLY === 'true' || process.env.MASTER === 'true') {
            return;
        }
        this.subscription = this.jobsService.newMiningJob$.subscribe(template => {
            this.upsert(template);
        });
    }

    public upsert(jobTemplate: IJobTemplate): TemplateProviderTemplate {
        this.cleanup();
        const templateId = BigInt(parseInt(jobTemplate.blockData.id, 16));
        const transactions = this.buildTransactions(jobTemplate.blockData.transactions ?? []);
        const template: TemplateProviderTemplate = {
            templateId,
            jobTemplate,
            version: jobTemplate.block.version,
            prevHash: Buffer.from(jobTemplate.block.prevHash),
            nBits: jobTemplate.block.bits,
            minNtime: jobTemplate.block.timestamp,
            coinbaseValue: BigInt(jobTemplate.blockData.coinbasevalue),
            networkDifficulty: jobTemplate.blockData.networkDifficulty,
            target: this.targetFromDifficulty(jobTemplate.blockData.networkDifficulty),
            height: jobTemplate.blockData.height,
            sigopLimit: jobTemplate.blockData.sigoplimit ?? 80_000,
            sizeLimit: jobTemplate.blockData.sizelimit ?? 4_000_000,
            weightLimit: jobTemplate.blockData.weightlimit ?? 4_000_000,
            transactions,
            transactionList: transactions.map(tx => Buffer.from(tx.data)),
            txidMap: this.buildMap(transactions, tx => tx.txid),
            wtxidMap: this.buildMap(transactions, tx => tx.wtxid),
            createdAt: Date.now(),
        };
        this.templates.set(template.templateId.toString(), template);
        this.latestTemplateId = template.templateId.toString();
        return template;
    }

    public getTemplate(templateId: bigint | number | string): TemplateProviderTemplate | undefined {
        this.cleanup();
        return this.templates.get(BigInt(templateId).toString());
    }

    public getLatestTemplate(): TemplateProviderTemplate | undefined {
        this.cleanup();
        return this.latestTemplateId == null ? undefined : this.templates.get(this.latestTemplateId);
    }

    public validateDeclaredWtxids(input: {
        version: number;
        wtxidList: Buffer[];
        coinbaseTxPrefix?: Buffer;
    }): DeclareMiningJobValidationResult {
        const template = this.getLatestTemplate();
        if (template == null) {
            return { valid: false, errorCode: 'template-not-found' };
        }
        if (input.version !== template.version) {
            return { valid: false, errorCode: 'version-mismatch', template };
        }
        if (input.coinbaseTxPrefix != null) {
            const coinbaseHeight = this.validateDeclaredCoinbasePrefixHeight(input.coinbaseTxPrefix, template.height);
            if (!coinbaseHeight.valid) {
                return { valid: false, errorCode: coinbaseHeight.errorCode, template };
            }
        }

        const seen = new Set<string>();
        const unknownTxPositionList: number[] = [];
        let duplicateFound = false;
        input.wtxidList.forEach((wtxid, index) => {
            const aliases = this.hashAliases(wtxid.toString('hex'));
            if (aliases.some(alias => seen.has(alias))) {
                duplicateFound = true;
                unknownTxPositionList.push(index);
                return;
            }
            aliases.forEach(alias => seen.add(alias));
            if (!this.lookupWtxid(template, wtxid)) {
                unknownTxPositionList.push(index);
            }
        });

        if (duplicateFound) {
            return {
                valid: false,
                errorCode: 'duplicate-transactions',
                template,
                unknownTxPositionList,
            };
        }

        return {
            valid: unknownTxPositionList.length === 0,
            errorCode: unknownTxPositionList.length > 0 ? 'missing-transactions' : undefined,
            template,
            unknownTxPositionList,
        };
    }

    public buildCoinbaseHeightPrefix(height: number): Buffer {
        const encodedHeight = bitcoinjs.script.number.encode(height);
        return Buffer.concat([Buffer.from([encodedHeight.length]), encodedHeight]);
    }

    public validateCoinbaseTransactionHeight(coinbaseTx: Buffer, height: number): CoinbaseHeightValidationResult {
        let tx: bitcoinjs.Transaction;
        try {
            tx = bitcoinjs.Transaction.fromBuffer(coinbaseTx);
        } catch (error) {
            return {
                valid: false,
                errorCode: `invalid-coinbase-transaction:${error instanceof Error ? error.message : String(error)}`,
            };
        }
        if (tx.ins.length !== 1) {
            return { valid: false, errorCode: 'invalid-coinbase-input-count' };
        }
        return this.validateCoinbaseScriptHeight(tx.ins[0].script, height);
    }

    public buildCoinbasePayoutOutputs(
        payoutInformation: AddressObject[],
        coinbaseValue: number | bigint,
        network: bitcoinjs.networks.Network,
    ): CoinbasePayoutOutput[] {
        const rewardValue = typeof coinbaseValue === 'bigint' ? coinbaseValue : BigInt(Math.max(0, Math.floor(coinbaseValue)));
        let rewardBalance = rewardValue;
        const outputs = payoutInformation.map(recipientAddress => {
            const value = recipientAddress.amountSats == null
                ? BigInt(Math.floor(((recipientAddress.percent ?? 0) / 100) * Number(rewardValue)))
                : BigInt(recipientAddress.amountSats);
            rewardBalance -= value;
            return {
                value,
                scriptPubKey: bitcoinjs.address.toOutputScript(recipientAddress.address, network),
            };
        });

        if (outputs.length > 0 && rewardBalance !== 0n) {
            outputs[0] = {
                ...outputs[0],
                value: outputs[0].value + rewardBalance,
            };
        }

        return outputs;
    }

    public validateCoinbaseTransactionPayoutOutputs(input: {
        coinbaseTx: Buffer;
        payoutInformation: AddressObject[];
        coinbaseValue: number | bigint;
        network: bitcoinjs.networks.Network;
    }): CoinbasePayoutValidationResult {
        const expectedOutputs = this.buildCoinbasePayoutOutputs(
            input.payoutInformation,
            input.coinbaseValue,
            input.network,
        );
        if (expectedOutputs.length === 0) {
            return { valid: false, errorCode: 'missing-expected-coinbase-payouts', expectedOutputs, submittedOutputs: [] };
        }

        let tx: bitcoinjs.Transaction;
        try {
            tx = bitcoinjs.Transaction.fromBuffer(input.coinbaseTx);
        } catch (error) {
            return {
                valid: false,
                errorCode: `invalid-coinbase-transaction:${error instanceof Error ? error.message : String(error)}`,
                expectedOutputs,
                submittedOutputs: [],
            };
        }

        const submittedOutputs = tx.outs
            .filter(output => !this.isWitnessCommitmentOutput(output.script))
            .filter(output => BigInt(output.value) !== 0n)
            .map(output => ({
                value: BigInt(output.value),
                scriptPubKey: Buffer.from(output.script),
            }));

        if (submittedOutputs.length !== expectedOutputs.length) {
            return {
                valid: false,
                errorCode: `coinbase-payout-output-count-mismatch:${expectedOutputs.length}:${submittedOutputs.length}`,
                expectedOutputs,
                submittedOutputs,
            };
        }

        for (let i = 0; i < expectedOutputs.length; i++) {
            const expected = expectedOutputs[i];
            const submitted = submittedOutputs[i];
            if (expected.value !== submitted.value || !expected.scriptPubKey.equals(submitted.scriptPubKey)) {
                return {
                    valid: false,
                    errorCode: `coinbase-payout-output-mismatch:${i}`,
                    expectedOutputs,
                    submittedOutputs,
                };
            }
        }

        return { valid: true, expectedOutputs, submittedOutputs };
    }

    public validateDeclaredCoinbasePrefixHeight(coinbaseTxPrefix: Buffer, height: number): CoinbaseHeightValidationResult {
        const scriptStart = this.getCoinbaseInputScriptStart(coinbaseTxPrefix);
        if (scriptStart == null) {
            return this.validateCoinbaseScriptHeight(coinbaseTxPrefix, height);
        }
        const expected = this.buildCoinbaseHeightPrefix(height);
        if (coinbaseTxPrefix.length < scriptStart + expected.length) {
            return { valid: false, errorCode: 'invalid-job-param-value-coinbase_tx_prefix' };
        }
        return this.validateCoinbaseScriptHeight(coinbaseTxPrefix.subarray(scriptStart), height);
    }

    public async validateProvidedTransactions(input: {
        expectedWtxids: Buffer[];
        unknownTxPositionList: number[];
        transactionList: Buffer[];
    }): Promise<{ valid: boolean; errorCode?: string }> {
        if (input.unknownTxPositionList.length !== input.transactionList.length) {
            return { valid: false, errorCode: 'missing-transaction-count-mismatch' };
        }
        const transactionValidation = this.validateTransactionData({
            transactionList: input.transactionList,
            expectedCount: input.transactionList.length,
        });
        if (!transactionValidation.valid) {
            return {
                valid: false,
                errorCode: transactionValidation.errorCode,
            };
        }
        for (let i = 0; i < input.transactionList.length; i++) {
            const position = input.unknownTxPositionList[i];
            const expected = input.expectedWtxids[position];
            const provided = transactionValidation.transactions![i];
            if (expected == null || !this.matchesHash(expected, provided.wtxid)) {
                return { valid: false, errorCode: 'transaction-wtxid-mismatch' };
            }
        }
        const mempoolResult = await this.validateMempoolPolicy(input.transactionList);
        if (!mempoolResult.valid) {
            return mempoolResult;
        }
        return { valid: true };
    }

    public validateTransactionData(input: {
        transactionList: Buffer[];
        expectedCount?: number;
        maxTotalBytes?: number;
        expectedCoinbaseMerklePath?: Buffer[];
    }): TransactionDataValidationResult {
        if (input.expectedCount != null && input.transactionList.length !== input.expectedCount) {
            return {
                valid: false,
                errorCode: `transaction-count-mismatch:${input.expectedCount}:${input.transactionList.length}`,
            };
        }

        let totalBytes = 0;
        const transactions: TemplateProviderTransaction[] = [];
        for (let i = 0; i < input.transactionList.length; i++) {
            const rawTransaction = input.transactionList[i];
            totalBytes += rawTransaction.length;
            if (input.maxTotalBytes != null && totalBytes > input.maxTotalBytes) {
                return {
                    valid: false,
                    errorCode: `transaction-bytes-exceed-limit:${totalBytes}:${input.maxTotalBytes}`,
                    totalBytes,
                };
            }
            try {
                transactions.push(this.parseTransaction(rawTransaction, i));
            } catch (error) {
                return {
                    valid: false,
                    errorCode: `transaction-decode-failed:${i}:${error instanceof Error ? error.message : String(error)}`,
                    totalBytes,
                };
            }
        }
        if (input.expectedCoinbaseMerklePath != null) {
            const merklePath = this.buildCoinbaseMerklePath(input.transactionList);
            if (merklePath.length !== input.expectedCoinbaseMerklePath.length) {
                return {
                    valid: false,
                    errorCode: `merkle-path-length-mismatch:${input.expectedCoinbaseMerklePath.length}:${merklePath.length}`,
                    totalBytes,
                };
            }
            for (let i = 0; i < merklePath.length; i++) {
                if (!merklePath[i].equals(input.expectedCoinbaseMerklePath[i])) {
                    return {
                        valid: false,
                        errorCode: `merkle-path-mismatch:${i}`,
                        totalBytes,
                    };
                }
            }
        }

        return {
            valid: true,
            transactions,
            totalBytes,
        };
    }

    public buildCoinbaseMerklePath(transactionList: Buffer[]): Buffer[] {
        const coinbasePlaceholderHash = Buffer.alloc(32);
        let level = [
            coinbasePlaceholderHash,
            ...transactionList.map(transaction => bitcoinjs.Transaction.fromBuffer(transaction).getHash(false)),
        ];
        let index = 0;
        const path: Buffer[] = [];

        while (level.length > 1) {
            const siblingIndex = index ^ 1;
            path.push(Buffer.from(level[siblingIndex] ?? level[index]));

            const nextLevel: Buffer[] = [];
            for (let i = 0; i < level.length; i += 2) {
                const left = level[i];
                const right = level[i + 1] ?? left;
                nextLevel.push(hash256(Buffer.concat([left, right])));
            }
            level = nextLevel;
            index = Math.floor(index / 2);
        }

        return path;
    }

    public validateDatumTemplateFastPath(input: DatumTemplateValidationInput): TemplateFastPathValidationResult {
        const template = this.getLatestTemplate();
        if (template == null) {
            return { valid: false, errorCode: 'template-not-found' };
        }
        if (input.prevBlockHash != null && !this.matchesHash(input.prevBlockHash, template.prevHash.toString('hex'))) {
            return { valid: false, errorCode: 'prevhash-mismatch', template };
        }
        if (input.nBits != null) {
            if (input.nBits.length !== 4) {
                return { valid: false, errorCode: 'nbits-mismatch', template };
            }
            if (input.nBits.readUInt32LE(0) !== template.nBits) {
                return { valid: false, errorCode: 'nbits-mismatch', template };
            }
        }
        if (input.height != null && input.height !== template.height) {
            return { valid: false, errorCode: 'height-mismatch', template };
        }
        if (input.version != null && !this.isCompatibleVersion(input.version, template.version)) {
            return { valid: false, errorCode: 'version-mismatch', template };
        }
        if (input.coinbaseValue != null && input.coinbaseValue > template.coinbaseValue) {
            return { valid: false, errorCode: 'coinbase-value-too-high', template };
        }
        if (input.totalWeight != null && input.totalWeight > template.weightLimit) {
            return { valid: false, errorCode: 'weight-limit-exceeded', template };
        }
        if (input.totalSize != null && input.totalSize > template.sizeLimit) {
            return { valid: false, errorCode: 'size-limit-exceeded', template };
        }
        if (input.totalSigops != null && input.totalSigops > template.sigopLimit) {
            return { valid: false, errorCode: 'sigop-limit-exceeded', template };
        }
        if (input.merkleBranches != null && input.merkleBranches.some(branch => branch.length !== 32)) {
            return { valid: false, errorCode: 'bad-merkle-branch', template };
        }
        return { valid: true, template };
    }

    public buildBlockFromSolution(input: {
        template: TemplateProviderTemplate;
        coinbaseTx: Buffer;
        version: number;
        headerTimestamp: number;
        headerNonce: number;
    }): bitcoinjs.Block {
        const block = new bitcoinjs.Block();
        block.version = input.version;
        block.prevHash = Buffer.from(input.template.prevHash);
        block.timestamp = input.headerTimestamp;
        block.bits = input.template.nBits;
        block.nonce = input.headerNonce;
        block.transactions = [
            bitcoinjs.Transaction.fromBuffer(input.coinbaseTx),
            ...input.template.transactionList.map(tx => bitcoinjs.Transaction.fromBuffer(tx)),
        ];
        block.merkleRoot = bitcoinjs.Block.calculateMerkleRoot(block.transactions, false);
        try {
            block.witnessCommit = bitcoinjs.Block.calculateMerkleRoot(block.transactions, true);
        } catch {
            block.witnessCommit = null;
        }
        return block;
    }

    public buildBlockFromDeclaredJobSolution(input: {
        template: TemplateProviderTemplate;
        job: Sv2DeclareMiningJob;
        providedTransactions?: Buffer[];
        solution: Sv2PushSolution;
    }): bitcoinjs.Block {
        const transactionMap = this.buildDeclaredTransactionMap(input.template, input.providedTransactions ?? []);
        const coinbaseTx = Buffer.concat([
            input.job.coinbaseTxPrefix,
            input.solution.extranonce,
            input.job.coinbaseTxSuffix,
        ]);
        const transactions = [bitcoinjs.Transaction.fromBuffer(coinbaseTx)];
        for (const wtxid of input.job.wtxidList) {
            const transaction = this.lookupDeclaredTransaction(transactionMap, wtxid);
            if (transaction == null) {
                throw new Error('declared-transaction-not-found');
            }
            transactions.push(bitcoinjs.Transaction.fromBuffer(transaction));
        }

        const block = new bitcoinjs.Block();
        block.version = input.solution.version;
        block.prevHash = Buffer.from(input.template.prevHash);
        block.timestamp = input.solution.ntime;
        block.bits = input.solution.nBits;
        block.nonce = input.solution.nonce;
        block.transactions = transactions;
        block.merkleRoot = bitcoinjs.Block.calculateMerkleRoot(block.transactions, false);
        try {
            block.witnessCommit = bitcoinjs.Block.calculateMerkleRoot(block.transactions, true);
        } catch {
            block.witnessCommit = null;
        }
        return block;
    }

    private buildTransactions(rawTransactions: IBlockTemplateTx[]): TemplateProviderTransaction[] {
        return rawTransactions.map((tx, index) => {
            const parsed = this.parseTransaction(Buffer.from(tx.data, 'hex'), index);
            return {
                ...parsed,
                txid: tx.txid || parsed.txid,
                wtxid: tx.hash || parsed.wtxid,
                fee: tx.fee ?? 0,
                sigops: tx.sigops ?? 0,
                weight: tx.weight ?? 0,
            };
        });
    }

    private parseTransaction(data: Buffer, position: number): TemplateProviderTransaction {
        const tx = bitcoinjs.Transaction.fromBuffer(data);
        return {
            position,
            data: Buffer.from(data),
            txid: tx.getId(),
            wtxid: Buffer.from(tx.getHash(true)).reverse().toString('hex'),
            fee: 0,
            sigops: 0,
            weight: 0,
        };
    }

    private validateCoinbaseScriptHeight(script: Buffer, height: number): CoinbaseHeightValidationResult {
        const expected = this.buildCoinbaseHeightPrefix(height);
        if (script.length < expected.length || !script.subarray(0, expected.length).equals(expected)) {
            return { valid: false, errorCode: 'invalid-job-param-value-coinbase_tx_prefix' };
        }
        return { valid: true };
    }

    private isWitnessCommitmentOutput(script: Buffer): boolean {
        return script.length === 38
            && script[0] === bitcoinjs.opcodes.OP_RETURN
            && script[1] === 0x24
            && script.subarray(2, 6).equals(Buffer.from('aa21a9ed', 'hex'));
    }

    private getCoinbaseInputScriptStart(txPrefix: Buffer): number | null {
        let cursor = 4;
        if (txPrefix.length < cursor + 1) {
            return null;
        }

        if (txPrefix.length >= 6 && txPrefix[4] === 0x00 && txPrefix[5] !== 0x00) {
            cursor = 6;
        }

        const inputCount = this.readBitcoinVarInt(txPrefix, cursor);
        if (inputCount == null || inputCount.value !== 1n) {
            return null;
        }
        cursor = inputCount.offset;
        if (txPrefix.length < cursor + 36) {
            return null;
        }
        cursor += 36;

        const scriptLength = this.readBitcoinVarInt(txPrefix, cursor);
        if (scriptLength == null) {
            return null;
        }
        return scriptLength.offset;
    }

    private readBitcoinVarInt(buffer: Buffer, offset: number): { value: bigint; offset: number } | null {
        if (offset >= buffer.length) {
            return null;
        }
        const first = buffer[offset];
        if (first < 0xfd) {
            return { value: BigInt(first), offset: offset + 1 };
        }
        if (first === 0xfd) {
            if (offset + 3 > buffer.length) {
                return null;
            }
            return { value: BigInt(buffer.readUInt16LE(offset + 1)), offset: offset + 3 };
        }
        if (first === 0xfe) {
            if (offset + 5 > buffer.length) {
                return null;
            }
            return { value: BigInt(buffer.readUInt32LE(offset + 1)), offset: offset + 5 };
        }
        if (offset + 9 > buffer.length) {
            return null;
        }
        return { value: buffer.readBigUInt64LE(offset + 1), offset: offset + 9 };
    }

    private buildDeclaredTransactionMap(
        template: TemplateProviderTemplate,
        providedTransactions: Buffer[],
    ): Map<string, Buffer> {
        const map = new Map<string, Buffer>();
        for (const tx of template.transactions) {
            for (const alias of this.hashAliases(tx.wtxid)) {
                map.set(alias, Buffer.from(tx.data));
            }
        }
        for (const provided of providedTransactions) {
            const parsed = this.parseTransaction(provided, -1);
            for (const alias of this.hashAliases(parsed.wtxid)) {
                map.set(alias, Buffer.from(provided));
            }
        }
        return map;
    }

    private lookupDeclaredTransaction(map: Map<string, Buffer>, hash: Buffer): Buffer | undefined {
        for (const alias of this.hashAliases(hash.toString('hex'))) {
            const found = map.get(alias);
            if (found != null) {
                return found;
            }
        }
        return undefined;
    }

    private buildMap(
        transactions: TemplateProviderTransaction[],
        selector: (tx: TemplateProviderTransaction) => string,
    ): Map<string, TemplateProviderTransaction> {
        const map = new Map<string, TemplateProviderTransaction>();
        for (const tx of transactions) {
            for (const key of this.hashAliases(selector(tx))) {
                map.set(key, tx);
            }
        }
        return map;
    }

    private lookupWtxid(template: TemplateProviderTemplate, hash: Buffer): TemplateProviderTransaction | undefined {
        for (const alias of this.hashAliases(hash.toString('hex'))) {
            const found = template.wtxidMap.get(alias);
            if (found != null) {
                return found;
            }
        }
        return undefined;
    }

    private matchesHash(candidate: Buffer, expectedHex: string): boolean {
        const aliases = this.hashAliases(expectedHex);
        return aliases.includes(candidate.toString('hex').toLowerCase());
    }

    private isCompatibleVersion(candidate: number, templateVersion: number): boolean {
        return (((candidate >>> 0) ^ (templateVersion >>> 0)) & ~VERSION_ROLLING_MASK) === 0;
    }

    private async validateMempoolPolicy(transactionList: Buffer[]): Promise<{ valid: boolean; errorCode?: string }> {
        if (transactionList.length === 0 || this.bitcoinRpcService?.TEST_MEMPOOL_ACCEPT == null) {
            return { valid: true };
        }
        try {
            const results = await this.bitcoinRpcService.TEST_MEMPOOL_ACCEPT(transactionList);
            const rejected = results.find(result => !result.allowed);
            if (rejected != null) {
                return {
                    valid: false,
                    errorCode: rejected.rejectReason || rejected.rejectDetails || 'mempool-rejected-transaction',
                };
            }
            return { valid: true };
        } catch (error) {
            return {
                valid: false,
                errorCode: `mempool-validation-failed:${error.message ?? error}`,
            };
        }
    }

    private hashAliases(hashHex: string): string[] {
        const normalized = hashHex.toLowerCase();
        const reversed = Buffer.from(normalized, 'hex').reverse().toString('hex');
        return normalized === reversed ? [normalized] : [normalized, reversed];
    }

    private targetFromDifficulty(difficulty: number): Buffer {
        const maxTarget = (BigInt(0xffff) << BigInt(8 * (0x1d - 3)));
        const divisor = BigInt(Math.max(1, Math.floor(difficulty)));
        const target = maxTarget / divisor;
        const result = Buffer.alloc(32);
        let remaining = target;
        for (let i = 0; i < 32; i++) {
            result[i] = Number(remaining & 0xffn);
            remaining >>= 8n;
        }
        return result;
    }

    private cleanup(): void {
        const cutoff = Date.now() - this.retentionMs;
        for (const [id, template] of this.templates.entries()) {
            if (template.createdAt < cutoff) {
                this.templates.delete(id);
                if (this.latestTemplateId === id) {
                    this.latestTemplateId = null;
                }
            }
        }
    }

    private readPositiveInt(name: string, fallback: number): number {
        const parsed = parseInt(process.env[name] ?? '', 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }
}
