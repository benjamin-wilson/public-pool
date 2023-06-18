import * as bitcoinjs from 'bitcoinjs-lib';
import * as crypto from 'crypto';
import { MerkleTree } from 'merkletreejs';

import { IBlockTemplate } from './bitcoin-rpc/IBlockTemplate';
import { eResponseMethod } from './enums/eResponseMethod';

interface AddressObject {
    address: string;
    percent: number;
}
export class MiningJob {
    public id: number;
    public method: eResponseMethod.MINING_NOTIFY;
    public params: string[];

    public target: string;
    public merkleRoot: string;

    public job_id: string; // ID of the job. Use this ID while submitting share generated from this job.
    public prevhash: string; // The hex-encoded previous block hash.
    public coinb1: string; // The hex-encoded prefix of the coinbase transaction (to precede extra nonce 2).
    public coinb2: string; //The hex-encoded suffix of the coinbase transaction (to follow extra nonce 2).
    public merkle_branch: string[]; // List of hashes, will be used for calculation of merkle root. This is not a list of all transactions, it only contains prepared hashes of steps of merkle tree algorithm.
    public version: number; // The hex-encoded block version.
    public nbits: number; // The hex-encoded network difficulty required for the block.
    public ntime: number; // Current ntime/
    //public clean_jobs: boolean; // When true, server indicates that submitting shares from previous jobs don't have a sense and such shares will be rejected. When this flag is set, miner should also drop all previous jobs too.

    public response: string;

    public versionMask: string;

    public tree: MerkleTree;

    constructor(id: string, payoutInformation: AddressObject[], public blockTemplate: IBlockTemplate, public networkDifficulty: number, public clean_jobs: boolean) {


        this.job_id = id;
        this.target = blockTemplate.target;
        this.prevhash = this.convertToLittleEndian(blockTemplate.previousblockhash);

        this.version = blockTemplate.version;
        this.nbits = parseInt(blockTemplate.bits, 16);
        this.ntime = Math.floor(new Date().getTime() / 1000);


        const transactionFees = blockTemplate.transactions.reduce((pre, cur, i, arr) => {
            return pre + cur.fee;
        }, 0);


        const { coinbasePart1, coinbasePart2 } = this.createCoinbaseTransaction(payoutInformation, blockTemplate.height, blockTemplate.coinbasevalue);

        this.coinb1 = coinbasePart1;
        this.coinb2 = coinbasePart2;

        const coinbaseHash = this.sha256(this.coinb1 + this.coinb2).toString('hex');
        const coinbaseBuffer = Buffer.from(coinbaseHash, 'hex');


        // Calculate merkle branch
        const transactionBuffers = blockTemplate.transactions.map(tx => Buffer.from(tx.hash, 'hex'));
        transactionBuffers.unshift(coinbaseBuffer);
        this.tree = new MerkleTree(transactionBuffers, this.sha256, { isBitcoinTree: true });

        const rootBuffer = this.tree.getRoot();
        this.merkleRoot = rootBuffer.toString('hex');
        this.merkle_branch = this.tree.getProof(coinbaseBuffer).map(p => p.data.toString('hex'));


        this.constructResponse();

    }

    private createCoinbaseTransaction(addresses: AddressObject[], blockHeight: number, reward: number): { coinbasePart1: string, coinbasePart2: string } {
        // Part 1
        const blockHeightScript = `03${blockHeight.toString(16).padStart(8, '0')}`;
        const outputIndex = 'ffffffff';


        const version = '01000000';
        const inputCount = '01';
        const fakeCoinbaseInput = '0000000000000000000000000000000000000000000000000000000000000000';

        const inputScriptBytes = ((blockHeightScript.length + 16) / 2).toString(16).padStart(2, '0');


        const coinbasePart1 = version + inputCount + fakeCoinbaseInput + outputIndex + inputScriptBytes + blockHeightScript;



        // Part 2
        const outputs = addresses
            .map((addressObj) => {
                const percentage = addressObj.percent / 100;
                const satoshis = Math.floor(reward * percentage);
                const satoshiBuff = Buffer.alloc(4);
                satoshiBuff.writeUInt32LE(satoshis);
                const littleEndianSatoshis = satoshiBuff.toString('hex').padEnd(16, '0');

                const script = bitcoinjs.payments.p2wpkh({ address: addressObj.address }).output.toString('hex') // Convert address to hex
                const scriptBytes = (script.length / 2).toString(16).padStart(2, '0');
                return littleEndianSatoshis + scriptBytes + script;
            })
            .join('');


        const outputCountHex = addresses.length.toString(16).padStart(2, '0');


        const sequence = 'ffffffff';
        const lockTime = '00000000';

        const coinbasePart2 = sequence + outputCountHex + outputs + lockTime;

        return { coinbasePart1, coinbasePart2 };
    }

    private sha256(data) {
        return crypto.createHash('sha256').update(data).digest()
    }


    private constructResponse() {

        const job = {
            id: null,
            method: eResponseMethod.MINING_NOTIFY,
            params: [
                this.job_id,
                this.prevhash,
                this.coinb1,
                this.coinb2,
                this.merkle_branch,
                this.version.toString(16),
                this.nbits.toString(16),
                this.ntime.toString(16),
                this.clean_jobs
            ]
        };

        this.response = JSON.stringify(job);

    }


    private convertToLittleEndian(hash: string): string {
        const bytes = Buffer.from(hash, 'hex');
        Array.prototype.reverse.call(bytes);
        return bytes.toString('hex');
    }




}