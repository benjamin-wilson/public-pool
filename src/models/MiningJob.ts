import { AddressType, getAddressInfo } from 'bitcoin-address-validation';
import * as bitcoinjs from 'bitcoinjs-lib';
import * as merkle from 'merkle-lib';
import * as merkleProof from 'merkle-lib/proof';

import { IBlockTemplate } from './bitcoin-rpc/IBlockTemplate';
import { eResponseMethod } from './enums/eResponseMethod';

interface AddressObject {
    address: string;
    percent: number;
}
export class MiningJob {

    private coinbasePart1: string;
    private coinbasePart2: string;

    private merkle_branch: string[]; // List of hashes, will be used for calculation of merkle root. This is not a list of all transactions, it only contains prepared hashes of steps of merkle tree algorithm.

    public jobId: string; // ID of the job. Use this ID while submitting share generated from this job.
    public block: bitcoinjs.Block = new bitcoinjs.Block();
    public networkDifficulty: number;

    constructor(id: string, payoutInformation: AddressObject[], public blockTemplate: IBlockTemplate, public clean_jobs: boolean) {

        this.jobId = id;
        this.block.prevHash = this.convertToLittleEndian(blockTemplate.previousblockhash);

        this.block.version = blockTemplate.version;
        this.block.bits = parseInt(blockTemplate.bits, 16);
        this.networkDifficulty = this.calculateNetworkDifficulty(this.block.bits);
        this.block.timestamp = Math.floor(new Date().getTime() / 1000);

        this.block.transactions = blockTemplate.transactions.map(t => bitcoinjs.Transaction.fromHex(t.data));

        const coinbaseTransaction = this.createCoinbaseTransaction(payoutInformation, this.blockTemplate.coinbasevalue);
        this.block.transactions.unshift(coinbaseTransaction);

        this.block.witnessCommit = bitcoinjs.Block.calculateMerkleRoot(this.block.transactions, true);

        // https://github.com/bitcoin/bips/blob/master/bip-0034.mediawiki
        const littleEndianBlockHeight = this.convertToLittleEndian(this.blockTemplate.height.toString(16).padStart(6, '0'))

        //The commitment is recorded in a scriptPubKey of the coinbase transaction. It must be at least 38 bytes, with the first 6-byte of 0x6a24aa21a9ed, that is:
        //     1-byte - OP_RETURN (0x6a)
        //     1-byte - Push the following 36 bytes (0x24)
        //     4-byte - Commitment header (0xaa21a9ed)
        const segwitMagicBits = Buffer.from('aa21a9ed', 'hex');
        //    32-byte - Commitment hash: Double-SHA256(witness root hash|witness reserved value)

        //    39th byte onwards: Optional data with no consensus meaning
        coinbaseTransaction.ins[0].script = Buffer.concat([Buffer.from([littleEndianBlockHeight.byteLength]), littleEndianBlockHeight, Buffer.alloc(8, 0)]);
        coinbaseTransaction.addOutput(bitcoinjs.script.compile([bitcoinjs.opcodes.OP_RETURN, Buffer.concat([segwitMagicBits, this.block.witnessCommit])]), 0);

        // get the non-witness coinbase tx
        //@ts-ignore
        const serializedCoinbaseTx = coinbaseTransaction.__toBuffer().toString('hex');

        const inputScript = coinbaseTransaction.ins[0].script.toString('hex');

        const partOneIndex = serializedCoinbaseTx.indexOf(inputScript) + inputScript.length;

        this.coinbasePart1 = serializedCoinbaseTx.slice(0, partOneIndex - 16);
        this.coinbasePart2 = serializedCoinbaseTx.slice(partOneIndex);


        // Calculate merkle branch
        const transactionBuffers = this.block.transactions.map(tx => tx.getHash(false));

        const merkleTree = merkle(transactionBuffers, bitcoinjs.crypto.hash256);
        const merkleBranches: Buffer[] = merkleProof(merkleTree, transactionBuffers[0]).filter(h => h != null);
        this.block.merkleRoot = merkleBranches.pop();

        // remove the first (coinbase) and last (root) element from the branch
        this.merkle_branch = merkleBranches.slice(1, merkleBranches.length).map(b => b.toString('hex'))

        this.block.transactions[0] = coinbaseTransaction;

    }

    public copyAndUpdateBlock(versionMask: number, nonce: number, extraNonce: string, extraNonce2: string, timestamp: number): bitcoinjs.Block {

        const testBlock = bitcoinjs.Block.fromBuffer(this.block.toBuffer());

        testBlock.nonce = nonce;

        // recompute version mask
        if (versionMask !== undefined && versionMask != 0) {
            testBlock.version = (testBlock.version ^ versionMask);
        }

        // set the nonces
        const nonceScript = testBlock.transactions[0].ins[0].script.toString('hex');

        testBlock.transactions[0].ins[0].script = Buffer.from(`${nonceScript.substring(0, nonceScript.length - 16)}${extraNonce}${extraNonce2}`, 'hex');

        //recompute the root since we updated the coinbase script with the nonces
        testBlock.merkleRoot = this.calculateMerkleRootHash(testBlock.transactions[0].getHash(false), this.merkle_branch);


        testBlock.timestamp = timestamp;

        return testBlock;
    }

    private calculateMerkleRootHash(newRoot: Buffer, merkleBranches: string[]): Buffer {

        const bothMerkles = Buffer.alloc(64);

        bothMerkles.set(newRoot);

        for (let i = 0; i < merkleBranches.length; i++) {
            bothMerkles.set(Buffer.from(merkleBranches[i], 'hex'), 32);
            newRoot = bitcoinjs.crypto.hash256(bothMerkles);
            bothMerkles.set(newRoot);
        }

        return bothMerkles.subarray(0, 32)
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
            const amount = Math.floor((recipientAddress.percent / 100) * reward);
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

    private getPaymentScript(address: string): Buffer {
        const addressInfo = getAddressInfo(address);
        switch (addressInfo.type) {
            case AddressType.p2wpkh: {
                return bitcoinjs.payments.p2wpkh({ address, network: bitcoinjs.networks.testnet }).output;
            }
            case AddressType.p2pkh: {
                return bitcoinjs.payments.p2pkh({ address }).output;
            }
            case AddressType.p2sh: {
                return bitcoinjs.payments.p2sh({ address }).output;
            }
            case AddressType.p2tr: {
                return bitcoinjs.payments.p2tr({ address }).output;
            }
            case AddressType.p2wsh: {
                return bitcoinjs.payments.p2wsh({ address }).output;
            }
            default: {
                return Buffer.alloc(0);
            }
        }
    }

    public response(): string {

        const job = {
            id: null,
            method: eResponseMethod.MINING_NOTIFY,
            params: [
                this.jobId,
                this.swapEndianWords(this.block.prevHash).toString('hex'),
                this.coinbasePart1,
                this.coinbasePart2,
                this.merkle_branch,
                this.block.version.toString(16),
                this.block.bits.toString(16),
                this.block.timestamp.toString(16),
                this.clean_jobs
            ]
        };

        return JSON.stringify(job) + '\n';
    }


    private convertToLittleEndian(hash: string): Buffer {
        const bytes = Buffer.from(hash, 'hex');
        Array.prototype.reverse.call(bytes);
        return bytes;
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


    private calculateNetworkDifficulty(nBits: number) {
        const mantissa: number = nBits & 0x007fffff;       // Extract the mantissa from nBits
        const exponent: number = (nBits >> 24) & 0xff;       // Extract the exponent from nBits

        const target: number = mantissa * Math.pow(256, (exponent - 3));   // Calculate the target value

        const difficulty: number = (Math.pow(2, 208) * 65535) / target;    // Calculate the difficulty

        return difficulty;
    }

}