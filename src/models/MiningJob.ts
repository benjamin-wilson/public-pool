import { AddressType, getAddressInfo } from 'bitcoin-address-validation';
import * as bitcoinjs from 'bitcoinjs-lib';

import { IJobTemplate } from '../services/stratum-v1-jobs.service';
import { PayoutMode } from '../types/payout-mode';
import { hash256 } from '../utils/hash.utils';
import { eResponseMethod } from './enums/eResponseMethod';
import { IMiningNotify } from './stratum-messages/IMiningNotify';
import { TOTAL_EXTRANONCE_SIZE_BYTES } from './stratum.constants';


export interface AddressObject {
    address: string;
    percent?: number;
    amountSats?: number;
}

export interface MiningJobOwnership {
    payoutMode: PayoutMode;
    payoutIdentity: string;
}

export class MiningJob {

    private static readonly paymentScriptCache = new Map<string, Buffer>();
    private static readonly paymentScriptCacheMaxEntries = 250_000;

    private coinbaseTransaction: bitcoinjs.Transaction;
    private coinbasePart1: string;
    private coinbasePart2: string;
    private coinbasePart1Buffer: Buffer;
    private coinbasePart2Buffer: Buffer;
    private merkleBranchBuffers: Buffer[];
    private miningNotifyResponse: string;
    private miningNotifyResponseBuffer: Buffer;

    public jobTemplateId: string;
    public tipKey: string;
    public networkDifficulty: number;
    public creation: number;

    constructor(
        private network: bitcoinjs.networks.Network,
        public jobId: string,
        payoutInformation: AddressObject[],
        jobTemplate: IJobTemplate,
        public readonly ownership?: MiningJobOwnership,
    ) {

        this.creation = new Date().getTime();
        this.jobTemplateId = jobTemplate.blockData.id;
        this.tipKey = jobTemplate.blockData.tipKey;
        this.merkleBranchBuffers = jobTemplate.merkle_branch.map(branch => Buffer.from(branch, 'hex'));

        this.coinbaseTransaction = this.createCoinbaseTransaction(payoutInformation, jobTemplate.blockData.coinbasevalue);

        //The commitment is recorded in a scriptPubKey of the coinbase transaction. It must be at least 38 bytes, with the first 6-byte of 0x6a24aa21a9ed, that is:
        //     1-byte - OP_RETURN (0x6a)
        //     1-byte - Push the following 36 bytes (0x24)
        //     4-byte - Commitment header (0xaa21a9ed)
        const segwitMagicBits = Buffer.from('aa21a9ed', 'hex');
        //    32-byte - Commitment hash: Double-SHA256(witness root hash|witness reserved value)

        //    39th byte onwards: Optional data with no consensus meaning
        const extra = Buffer.from('Public-Pool');

        // BIP34 uses Bitcoin Script's minimally encoded integer push. Heights
        // 1..16 are OP_1..OP_16, not a one-byte PUSHDATA operation. Keeping the
        // extranonce padding independent of the height width also prevents a
        // future four-byte height from consuming part of the pool tag.
        const blockHeightPrefix = this.encodeCoinbaseHeight(jobTemplate.blockData.height);
        const padding = Buffer.alloc(TOTAL_EXTRANONCE_SIZE_BYTES, 0);

        // Build the script with the extranonce placeholder at the very end.
        this.coinbaseTransaction.ins[0].script = Buffer.concat([blockHeightPrefix, extra, padding]);

        this.coinbaseTransaction.addOutput(bitcoinjs.script.compile([bitcoinjs.opcodes.OP_RETURN, Buffer.concat([segwitMagicBits, jobTemplate.block.witnessCommit])]), 0);

        // get the non-witness coinbase tx
        //@ts-ignore
        const serializedCoinbaseTx = this.coinbaseTransaction.__toBuffer().toString('hex');

        const inputScript = this.coinbaseTransaction.ins[0].script.toString('hex');

        const partOneIndex = serializedCoinbaseTx.indexOf(inputScript) + inputScript.length;

        this.coinbasePart1 = serializedCoinbaseTx.slice(0, partOneIndex - (TOTAL_EXTRANONCE_SIZE_BYTES * 2));
        this.coinbasePart2 = serializedCoinbaseTx.slice(partOneIndex);
        this.coinbasePart1Buffer = Buffer.from(this.coinbasePart1, 'hex');
        this.coinbasePart2Buffer = Buffer.from(this.coinbasePart2, 'hex');


    }

    public cloneCoinbaseTransaction(): bitcoinjs.Transaction {
        return bitcoinjs.Transaction.fromBuffer(this.coinbaseTransaction.toBuffer());
    }

    public getCoinbasePrefixBuffer(): Buffer {
        return Buffer.from(this.coinbasePart1Buffer);
    }

    public getCoinbaseSuffixBuffer(): Buffer {
        return Buffer.from(this.coinbasePart2Buffer);
    }

    public buildCoinbaseMerkleRoot(extraNonce: string, extraNonce2: string): Buffer {
        const coinbaseBuffer = Buffer.concat([
            this.coinbasePart1Buffer,
            Buffer.from(`${extraNonce}${extraNonce2}`, 'hex'),
            this.coinbasePart2Buffer,
        ]);
        return MiningJob.calculateMerkleRootFromCoinbaseHash(
            hash256(coinbaseBuffer),
            this.merkleBranchBuffers,
        );
    }

    public static calculateMerkleRootFromCoinbaseHash(
        coinbaseHash: Buffer,
        merkleBranches: readonly Buffer[],
    ): Buffer {
        let merkleRoot = coinbaseHash;
        const bothMerkles = Buffer.alloc(64);
        for (const merkleBranch of merkleBranches) {
            bothMerkles.set(merkleRoot, 0);
            bothMerkles.set(merkleBranch, 32);
            merkleRoot = hash256(bothMerkles);
        }
        return merkleRoot;
    }

    public static applyVersionRolling(jobVersion: number, versionBits: number, mask: number): number {
        const unsignedJobVersion = jobVersion >>> 0;
        const unsignedVersionBits = versionBits >>> 0;
        const unsignedMask = mask >>> 0;
        return (
            (unsignedJobVersion & (~unsignedMask >>> 0))
            | (unsignedVersionBits & unsignedMask)
        ) >>> 0;
    }

    public buildHeaderBuffer(
        jobTemplate: IJobTemplate,
        versionBits: number,
        nonce: number,
        extraNonce: string,
        extraNonce2: string,
        timestamp: number,
        versionRollingMask?: number,
    ): Buffer {
        const merkleRoot = this.buildCoinbaseMerkleRoot(extraNonce, extraNonce2);

        const version = versionRollingMask == null
            // SV2 standard-channel reconstruction passes an XOR delta because
            // its submit message contains the complete version field.
            ? (jobTemplate.block.version ^ versionBits) >>> 0
            : MiningJob.applyVersionRolling(jobTemplate.block.version, versionBits, versionRollingMask);

        const header = Buffer.alloc(80);
        header.writeUInt32LE(version, 0);
        jobTemplate.block.prevHash.copy(header, 4);
        merkleRoot.copy(header, 36);
        header.writeUInt32LE(timestamp, 68);
        header.writeUInt32LE(jobTemplate.block.bits, 72);
        header.writeUInt32LE(nonce, 76);

        return header;
    }

    public copyAndUpdateBlock(
        jobTemplate: IJobTemplate,
        versionBits: number,
        nonce: number,
        extraNonce: string,
        extraNonce2: string,
        timestamp: number,
        versionRollingMask?: number,
    ): bitcoinjs.Block {

        const testBlock = Object.assign(new bitcoinjs.Block(), jobTemplate.block);
        const rawTransactions = jobTemplate.blockData.transactions;
        testBlock.transactions = [
            this.cloneCoinbaseTransaction(),
            ...(rawTransactions == null
                ? jobTemplate.block.transactions.slice(1).map(tx =>
                    Object.assign(new bitcoinjs.Transaction(), tx))
                : rawTransactions.map((rawTransaction, index) => {
                    const transaction = bitcoinjs.Transaction.fromHex(rawTransaction.data);
                    if (transaction.getId().toLowerCase() !== rawTransaction.txid.toLowerCase()) {
                        throw new Error(`transactions[${index}] data does not match its txid`);
                    }
                    return transaction;
                })),
        ];

        testBlock.nonce = nonce;

        const version = versionRollingMask == null
            ? (testBlock.version ^ versionBits) >>> 0
            : MiningJob.applyVersionRolling(testBlock.version, versionBits, versionRollingMask);
        // bitcoinjs-lib serializes Block.version as a signed int32, while the
        // protocol and bit-mask arithmetic use the corresponding uint32 bits.
        testBlock.version = version | 0;

        // set the nonces
        const nonceScript = testBlock.transactions[0].ins[0].script.toString('hex');

        testBlock.transactions[0].ins[0].script = Buffer.from(`${nonceScript.substring(0, nonceScript.length - (TOTAL_EXTRANONCE_SIZE_BYTES * 2))}${extraNonce}${extraNonce2}`, 'hex');

        //recompute the root since we updated the coinbase script with the nonces
        testBlock.merkleRoot = MiningJob.calculateMerkleRootFromCoinbaseHash(
            testBlock.transactions[0].getHash(false),
            this.merkleBranchBuffers,
        );


        testBlock.timestamp = timestamp;

        return testBlock;
    }


    private createCoinbaseTransaction(addresses: AddressObject[], reward: number): bitcoinjs.Transaction {
        // Part 1
        const coinbaseTransaction = new bitcoinjs.Transaction();

        // Set the version of the transaction
        coinbaseTransaction.version = 2;

        // Add the coinbase input (input with no previous output)
        coinbaseTransaction.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);

        // Add an output
        let rewardBalance = reward;

        addresses.forEach(recipientAddress => {
            const amount = recipientAddress.amountSats == null
                ? Math.floor(((recipientAddress.percent ?? 0) / 100) * reward)
                : recipientAddress.amountSats;
            rewardBalance -= amount;
            coinbaseTransaction.addOutput(this.getPaymentScript(recipientAddress.address), amount);
        })

        //Add any remaining sats from the Math.floor
        coinbaseTransaction.outs[0].value += rewardBalance;

        const segwitWitnessReservedValue = Buffer.alloc(32, 0);

        //and the coinbase's input's witness must consist of a single 32-byte array for the witness reserved value
        coinbaseTransaction.ins[0].witness = [segwitWitnessReservedValue];

        return coinbaseTransaction;
    }

    private encodeCoinbaseHeight(height: number): Buffer {
        if (!Number.isSafeInteger(height) || height < 0) {
            throw new Error('Coinbase height must be a non-negative safe integer');
        }
        if (height === 0) {
            return Buffer.from([bitcoinjs.opcodes.OP_0]);
        }
        if (height <= 16) {
            return Buffer.from([bitcoinjs.opcodes.OP_1 + height - 1]);
        }

        const encoded = bitcoinjs.script.number.encode(height);
        if (encoded.length >= bitcoinjs.opcodes.OP_PUSHDATA1) {
            throw new Error('Coinbase height encoding is unexpectedly large');
        }
        return Buffer.concat([Buffer.from([encoded.length]), encoded]);
    }

    private getPaymentScript(address: string): Buffer {
        const cacheKey = `${this.network.bech32}:${this.network.pubKeyHash}:${this.network.scriptHash}:${address}`;
        const cached = MiningJob.paymentScriptCache.get(cacheKey);
        if (cached != null) {
            return cached;
        }

        const addressInfo = getAddressInfo(address);
        let paymentScript: Buffer;
        switch (addressInfo.type) {
            case AddressType.p2wpkh: {
                paymentScript = bitcoinjs.payments.p2wpkh({ address, network: this.network }).output;
                break;
            }
            case AddressType.p2pkh: {
                paymentScript = bitcoinjs.payments.p2pkh({ address, network: this.network }).output;
                break;
            }
            case AddressType.p2sh: {
                paymentScript = bitcoinjs.payments.p2sh({ address, network: this.network }).output;
                break;
            }
            case AddressType.p2tr: {
                paymentScript = bitcoinjs.payments.p2tr({ address, network: this.network }).output;
                break;
            }
            case AddressType.p2wsh: {
                paymentScript = bitcoinjs.payments.p2wsh({ address, network: this.network }).output;
                break;
            }
            default: {
                paymentScript = Buffer.alloc(0);
                break;
            }
        }

        MiningJob.paymentScriptCache.set(cacheKey, paymentScript);
        if (MiningJob.paymentScriptCache.size > MiningJob.paymentScriptCacheMaxEntries) {
            const oldest = MiningJob.paymentScriptCache.keys().next().value;
            if (oldest != null) {
                MiningJob.paymentScriptCache.delete(oldest);
            }
        }
        return paymentScript;
    }

    public response(jobTemplate: IJobTemplate): string {

        if (this.miningNotifyResponse != null) {
            return this.miningNotifyResponse;
        }

        const job: IMiningNotify = {
            id: null,
            method: eResponseMethod.MINING_NOTIFY,
            params: [
                this.jobId,
                this.swapEndianWords(jobTemplate.block.prevHash).toString('hex'),
                this.coinbasePart1,
                this.coinbasePart2,
                jobTemplate.merkle_branch,
                jobTemplate.block.version.toString(16),
                jobTemplate.block.bits.toString(16),
                jobTemplate.block.timestamp.toString(16),
                jobTemplate.blockData.clearJobs
            ]
        };

        this.miningNotifyResponse = JSON.stringify(job) + '\n';
        this.miningNotifyResponseBuffer = Buffer.from(this.miningNotifyResponse);
        return this.miningNotifyResponse;
    }

    public responseBuffer(jobTemplate: IJobTemplate): Buffer {
        if (this.miningNotifyResponseBuffer == null) {
            this.response(jobTemplate);
        }
        return this.miningNotifyResponseBuffer;
    }


    private swapEndianWords(buffer: Buffer): Buffer {
        const swappedBuffer = Buffer.alloc(buffer.length);

        for (let i = 0; i < buffer.length; i += 4) {
            swappedBuffer[i] = buffer[i + 3];
            swappedBuffer[i + 1] = buffer[i + 2];
            swappedBuffer[i + 2] = buffer[i + 1];
            swappedBuffer[i + 3] = buffer[i];
        }

        return swappedBuffer;
    }


}
