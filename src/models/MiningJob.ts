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
    public coinbaseTransaction: bitcoinjs.Transaction;

    constructor(id: string, payoutInformation: AddressObject[], public blockTemplate: IBlockTemplate, public networkDifficulty: number, public clean_jobs: boolean) {


        this.job_id = id;
        this.target = blockTemplate.target;
        this.prevhash = this.convertToLittleEndian(blockTemplate.previousblockhash);

        this.version = blockTemplate.version;
        this.nbits = parseInt(blockTemplate.bits, 16);
        this.ntime = Math.floor(new Date().getTime() / 1000);


        const allTransactions = blockTemplate.transactions.map(t => bitcoinjs.Transaction.fromHex(t.data));

        this.coinbaseTransaction = this.createCoinbaseTransaction(payoutInformation, this.blockTemplate.height, this.blockTemplate.coinbasevalue);
        allTransactions.unshift(this.coinbaseTransaction);
        const witnessRootHash = bitcoinjs.Block.calculateMerkleRoot(allTransactions, true);



        //The commitment is recorded in a scriptPubKey of the coinbase transaction. It must be at least 38 bytes, with the first 6-byte of 0x6a24aa21a9ed, that is:
        //     1-byte - OP_RETURN (0x6a)
        //     1-byte - Push the following 36 bytes (0x24)
        //     4-byte - Commitment header (0xaa21a9ed)
        const segwitMagicBits = Buffer.from('aa21a9ed', 'hex');
        //    32-byte - Commitment hash: Double-SHA256(witness root hash|witness reserved value)
        const merkleRoot = this.sha256(this.sha256(witnessRootHash));
        //    39th byte onwards: Optional data with no consensus meaning
        this.coinbaseTransaction.outs[0].script = bitcoinjs.script.compile([bitcoinjs.opcodes.OP_RETURN, Buffer.concat([segwitMagicBits, merkleRoot])]);

        //@ts-ignore
        const serializedTx = this.coinbaseTransaction.__toBuffer().toString('hex');

        const blockHeightScript = `03${this.blockTemplate.height.toString(16).padStart(8, '0')}` + '00000000' + '00000000';
        const partOneIndex = serializedTx.indexOf(blockHeightScript) + blockHeightScript.length;

        const coinbasePart1 = serializedTx.slice(0, partOneIndex);
        const coinbasePart2 = serializedTx.slice(partOneIndex);
        this.coinb1 = coinbasePart1.slice(0, coinbasePart1.length - 16);
        this.coinb2 = coinbasePart2;


        // Calculate merkle branch
        const transactionBuffers = allTransactions.map(tx => tx.getHash(false));

        this.tree = new MerkleTree(transactionBuffers, this.sha256, { isBitcoinTree: true });

        const rootBuffer = this.tree.getRoot();
        this.merkleRoot = rootBuffer.toString('hex');
        this.merkle_branch = this.tree.getProof(this.coinbaseTransaction.getHash(false)).map(p => p.data.toString('hex'));


        this.constructResponse();

    }

    private createCoinbaseTransaction(addresses: AddressObject[], blockHeight: number, reward: number): bitcoinjs.Transaction {
        // Part 1
        const tx = new bitcoinjs.Transaction();

        // Set the version of the transaction
        tx.version = 2;

        const blockHeightScript = `03${blockHeight.toString(16).padStart(8, '0')}` + '00000000' + '00000000';
        // const inputScriptBytes = ((blockHeightScript.length + 16) / 2).toString(16).padStart(2, '0');
        // const OP_RETURN = '6a';
        // const inputScript = `${OP_RETURN}${inputScriptBytes}${blockHeightScript}`

        const inputScript = bitcoinjs.script.compile([bitcoinjs.opcodes.OP_RETURN, Buffer.from(blockHeightScript, 'hex')])

        // Add the coinbase input (input with no previous output)
        tx.addInput(Buffer.from('0000000000000000000000000000000000000000000000000000000000000000', 'hex'), 0xffffffff, 0xffffffff, inputScript);

        // Add an output
        const recipientAddress = addresses[0].address;

        const scriptPubKey = bitcoinjs.payments.p2wpkh({ address: recipientAddress, network: bitcoinjs.networks.testnet });
        tx.addOutput(scriptPubKey.output, reward);





        const segwitWitnessReservedValue = Buffer.alloc(32, 0);


        //and the coinbase's input's witness must consist of a single 32-byte array for the witness reserved value

        tx.ins[0].witness = [segwitWitnessReservedValue];



        return tx;
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