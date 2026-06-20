import { BehaviorSubject, firstValueFrom } from 'rxjs';
import * as bitcoinjs from 'bitcoinjs-lib';

import { MockRecording1 } from '../../test/models/MockRecording1';
import { CustomWorkService } from './custom-work.service';
import { StratumV1JobsService } from './stratum-v1-jobs.service';
import { TemplateProviderService } from './template-provider.service';

describe('TemplateProviderService', () => {
    it('indexes template transactions and validates known wtxids', async () => {
        const { provider, jobTemplate } = await createProvider();
        const template = provider.upsert(jobTemplate);
        const firstTx = MockRecording1.BLOCK_TEMPLATE.transactions[0];

        expect(template.transactionList[0]).toEqual(Buffer.from(firstTx.data, 'hex'));
        expect(provider.getTemplate(template.templateId)).toBe(template);

        const validation = provider.validateDeclaredWtxids({
            version: MockRecording1.BLOCK_TEMPLATE.version,
            wtxidList: [Buffer.from(firstTx.hash, 'hex')],
        });
        expect(validation.valid).toBe(true);
        expect(validation.template).toBe(template);
    });

    it('reports unknown transaction positions and validates supplied missing tx bytes', async () => {
        const { provider, jobTemplate } = await createProvider();
        provider.upsert(jobTemplate);
        const firstTx = MockRecording1.BLOCK_TEMPLATE.transactions[0];
        const unknownWtxid = Buffer.alloc(32, 0xaa);

        const validation = provider.validateDeclaredWtxids({
            version: MockRecording1.BLOCK_TEMPLATE.version,
            wtxidList: [Buffer.from(firstTx.hash, 'hex'), unknownWtxid],
        });
        expect(validation.valid).toBe(false);
        expect(validation.errorCode).toBe('missing-transactions');
        expect(validation.unknownTxPositionList).toEqual([1]);

        const missingTxValidation = await provider.validateProvidedTransactions({
            expectedWtxids: [Buffer.from(firstTx.hash, 'hex'), unknownWtxid],
            unknownTxPositionList: [1],
            transactionList: [Buffer.from(firstTx.data, 'hex')],
        });
        expect(missingTxValidation.valid).toBe(false);
        expect(missingTxValidation.errorCode).toBe('transaction-wtxid-mismatch');
    });

    it('rejects duplicate declared wtxids before requesting missing transactions', async () => {
        const { provider, jobTemplate } = await createProvider();
        provider.upsert(jobTemplate);
        const firstTx = MockRecording1.BLOCK_TEMPLATE.transactions[0];

        const validation = provider.validateDeclaredWtxids({
            version: MockRecording1.BLOCK_TEMPLATE.version,
            wtxidList: [
                Buffer.from(firstTx.hash, 'hex'),
                Buffer.from(firstTx.hash, 'hex'),
            ],
        });

        expect(validation.valid).toBe(false);
        expect(validation.errorCode).toBe('duplicate-transactions');
    });

    it('builds and validates the BIP34 coinbase height prefix for SV2 templates', async () => {
        const { provider, jobTemplate } = await createProvider();
        const template = provider.upsert(jobTemplate);
        const heightPrefix = provider.buildCoinbaseHeightPrefix(template.height);
        const coinbaseTx = createCoinbaseTransaction(heightPrefix);

        expect(heightPrefix).toEqual(Buffer.concat([
            Buffer.from([bitcoinjs.script.number.encode(template.height).length]),
            bitcoinjs.script.number.encode(template.height),
        ]));
        expect(provider.validateCoinbaseTransactionHeight(coinbaseTx.toBuffer(), template.height)).toEqual({ valid: true });
    });

    it('rejects declared SV2 JDP coinbase prefixes missing the required BIP34 height', async () => {
        const { provider, jobTemplate } = await createProvider();
        const template = provider.upsert(jobTemplate);
        const badScript = Buffer.from('/public-pool-sri-jdc-e2e/', 'utf8');
        const badPrefix = createCoinbasePrefixForScript(badScript, badScript);

        const validation = provider.validateDeclaredWtxids({
            version: MockRecording1.BLOCK_TEMPLATE.version,
            coinbaseTxPrefix: badPrefix,
            wtxidList: [],
        });

        expect(validation).toMatchObject({
            valid: false,
            errorCode: 'invalid-job-param-value-coinbase_tx_prefix',
            template,
        });
    });

    it('accepts declared SV2 JDP coinbase prefixes that start with the required BIP34 height', async () => {
        const { provider, jobTemplate } = await createProvider();
        const template = provider.upsert(jobTemplate);
        const heightPrefix = provider.buildCoinbaseHeightPrefix(template.height);
        const validPrefix = createCoinbasePrefixForScript(
            Buffer.concat([heightPrefix, Buffer.from('/public-pool-sri-jdc-e2e/', 'utf8')]),
            heightPrefix,
        );

        const validation = provider.validateDeclaredWtxids({
            version: MockRecording1.BLOCK_TEMPLATE.version,
            coinbaseTxPrefix: validPrefix,
            wtxidList: [],
        });

        expect(validation.valid).toBe(true);
        expect(validation.template).toBe(template);
    });

    it('accepts declared SV2 JDP script-only coinbase prefixes that start with the required BIP34 height', async () => {
        const { provider, jobTemplate } = await createProvider();
        const template = provider.upsert(jobTemplate);
        const scriptOnlyPrefix = Buffer.concat([
            provider.buildCoinbaseHeightPrefix(template.height),
            Buffer.from('/public-pool-sri-jdc-e2e/', 'utf8'),
        ]);

        const validation = provider.validateDeclaredWtxids({
            version: MockRecording1.BLOCK_TEMPLATE.version,
            coinbaseTxPrefix: scriptOnlyPrefix,
            wtxidList: [],
        });

        expect(validation.valid).toBe(true);
        expect(validation.template).toBe(template);
    });

    it('ignores zero-value extra outputs when validating coinbase payouts', async () => {
        const { provider, jobTemplate } = await createProvider();
        const coinbaseTx = createCoinbaseTransaction(provider.buildCoinbaseHeightPrefix(jobTemplate.blockData.height));
        coinbaseTx.addOutput(
            bitcoinjs.address.toOutputScript('tb1qdyjakeepue4trak9d3hvyelrd0aw7mwju2d0c2', bitcoinjs.networks.testnet),
            0,
        );
        coinbaseTx.addOutput(
            bitcoinjs.address.toOutputScript('tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4', bitcoinjs.networks.testnet),
            jobTemplate.blockData.coinbasevalue,
        );

        const validation = provider.validateCoinbaseTransactionPayoutOutputs({
            coinbaseTx: coinbaseTx.toBuffer(),
            payoutInformation: [{
                address: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
                amountSats: jobTemplate.blockData.coinbasevalue,
            }],
            coinbaseValue: jobTemplate.blockData.coinbasevalue,
            network: bitcoinjs.networks.testnet,
        });

        expect(validation.valid).toBe(true);
    });

    it('accepts DATUM template metadata matching the latest template fast path', async () => {
        const { provider, jobTemplate } = await createProvider();
        const template = provider.upsert(jobTemplate);
        const nBits = Buffer.alloc(4);
        nBits.writeUInt32LE(template.nBits, 0);

        const validation = provider.validateDatumTemplateFastPath({
            prevBlockHash: Buffer.from(template.prevHash),
            nBits,
            height: template.height,
            version: template.version ^ 0x2000,
            coinbaseValue: template.coinbaseValue,
            totalWeight: template.weightLimit,
            totalSize: template.sizeLimit,
            totalSigops: template.sigopLimit,
            merkleBranches: [Buffer.alloc(32)],
        });

        expect(validation.valid).toBe(true);
        expect(validation.template).toBe(template);
    });

    it('rejects stale or impossible DATUM template metadata in the fast path', async () => {
        const { provider, jobTemplate } = await createProvider();
        const template = provider.upsert(jobTemplate);
        const nBits = Buffer.alloc(4);
        nBits.writeUInt32LE(template.nBits, 0);

        expect(provider.validateDatumTemplateFastPath({
            prevBlockHash: Buffer.alloc(32, 0xaa),
            nBits,
            height: template.height,
        })).toMatchObject({ valid: false, errorCode: 'prevhash-mismatch' });

        expect(provider.validateDatumTemplateFastPath({
            prevBlockHash: Buffer.from(template.prevHash),
            nBits,
            height: template.height + 1,
        })).toMatchObject({ valid: false, errorCode: 'height-mismatch' });

        expect(provider.validateDatumTemplateFastPath({
            prevBlockHash: Buffer.from(template.prevHash),
            nBits,
            height: template.height,
            coinbaseValue: template.coinbaseValue + 1n,
        })).toMatchObject({ valid: false, errorCode: 'coinbase-value-too-high' });

        expect(provider.validateDatumTemplateFastPath({
            prevBlockHash: Buffer.from(template.prevHash),
            nBits,
            height: template.height,
            totalWeight: template.weightLimit + 1,
        })).toMatchObject({ valid: false, errorCode: 'weight-limit-exceeded' });
    });

    it('validates supplied missing transactions against Bitcoin Core mempool policy', async () => {
        const firstTx = MockRecording1.BLOCK_TEMPLATE.transactions[0];
        const { provider, bitcoinRpcService } = await createProvider({
            TEST_MEMPOOL_ACCEPT: jest.fn().mockResolvedValue([{ allowed: true }]),
        });

        const validation = await provider.validateProvidedTransactions({
            expectedWtxids: [Buffer.from(firstTx.hash, 'hex')],
            unknownTxPositionList: [0],
            transactionList: [Buffer.from(firstTx.data, 'hex')],
        });

        expect(validation.valid).toBe(true);
        expect(bitcoinRpcService.TEST_MEMPOOL_ACCEPT).toHaveBeenCalledWith([Buffer.from(firstTx.data, 'hex')]);
    });

    it('rejects malformed supplied missing transactions before mempool policy checks', async () => {
        const firstTx = MockRecording1.BLOCK_TEMPLATE.transactions[0];
        const { provider, bitcoinRpcService } = await createProvider({
            TEST_MEMPOOL_ACCEPT: jest.fn().mockResolvedValue([{ allowed: true }]),
        });

        const validation = await provider.validateProvidedTransactions({
            expectedWtxids: [Buffer.from(firstTx.hash, 'hex')],
            unknownTxPositionList: [0],
            transactionList: [Buffer.from('010203', 'hex')],
        });

        expect(validation.valid).toBe(false);
        expect(validation.errorCode).toMatch(/^transaction-decode-failed:0:/);
        expect(bitcoinRpcService.TEST_MEMPOOL_ACCEPT).not.toHaveBeenCalled();
    });

    it('validates generic transaction data for SV2 and DATUM callers', async () => {
        const firstTx = MockRecording1.BLOCK_TEMPLATE.transactions[0];
        const { provider } = await createProvider();

        const valid = provider.validateTransactionData({
            transactionList: [Buffer.from(firstTx.data, 'hex')],
            expectedCount: 1,
            maxTotalBytes: Buffer.from(firstTx.data, 'hex').length,
        });
        expect(valid.valid).toBe(true);
        expect(valid.transactions?.[0].wtxid).toBe(firstTx.hash);

        expect(provider.validateTransactionData({
            transactionList: [Buffer.from(firstTx.data, 'hex')],
            expectedCount: 2,
        })).toMatchObject({
            valid: false,
            errorCode: 'transaction-count-mismatch:2:1',
        });

        expect(provider.validateTransactionData({
            transactionList: [Buffer.from(firstTx.data, 'hex')],
            maxTotalBytes: 1,
        })).toMatchObject({
            valid: false,
            errorCode: expect.stringMatching(/^transaction-bytes-exceed-limit:/),
        });
    });

    it('validates DATUM transaction blobs against the advertised coinbase merkle path', async () => {
        const { provider } = await createProvider();
        const coinbaseTx = createTestTransaction(0);
        const transactionList = [
            createTestTransaction(1),
            createTestTransaction(2),
            createTestTransaction(3),
        ];
        const merklePath = provider.buildCoinbaseMerklePath(transactionList);
        const merkleRoot = new CustomWorkService().computeMerkleRoot(coinbaseTx, merklePath);
        const block = new bitcoinjs.Block();
        block.transactions = [
            bitcoinjs.Transaction.fromBuffer(coinbaseTx),
            ...transactionList.map(tx => bitcoinjs.Transaction.fromBuffer(tx)),
        ];

        expect(merkleRoot).toEqual(bitcoinjs.Block.calculateMerkleRoot(block.transactions, false));
        expect(provider.validateTransactionData({
            transactionList,
            expectedCount: transactionList.length,
            expectedCoinbaseMerklePath: merklePath,
        })).toMatchObject({ valid: true });

        const wrongPath = merklePath.map(branch => Buffer.from(branch));
        wrongPath[0][0] ^= 0xff;
        expect(provider.validateTransactionData({
            transactionList,
            expectedCount: transactionList.length,
            expectedCoinbaseMerklePath: wrongPath,
        })).toMatchObject({
            valid: false,
            errorCode: 'merkle-path-mismatch:0',
        });
    });

    it('rejects supplied missing transactions rejected by Bitcoin Core mempool policy', async () => {
        const firstTx = MockRecording1.BLOCK_TEMPLATE.transactions[0];
        const { provider } = await createProvider({
            TEST_MEMPOOL_ACCEPT: jest.fn().mockResolvedValue([{
                allowed: false,
                rejectReason: 'txn-mempool-conflict',
            }]),
        });

        const validation = await provider.validateProvidedTransactions({
            expectedWtxids: [Buffer.from(firstTx.hash, 'hex')],
            unknownTxPositionList: [0],
            transactionList: [Buffer.from(firstTx.data, 'hex')],
        });

        expect(validation.valid).toBe(false);
        expect(validation.errorCode).toBe('txn-mempool-conflict');
    });

    async function createProvider(bitcoinRpcService?: any): Promise<{
        provider: TemplateProviderService;
        jobTemplate: any;
        bitcoinRpcService: any;
    }> {
        const blockTemplate$ = new BehaviorSubject(MockRecording1.BLOCK_TEMPLATE);
        const jobsService = new StratumV1JobsService({
            newBlockTemplate$: blockTemplate$.asObservable(),
            miningInfo: { blocks: MockRecording1.BLOCK_TEMPLATE.height },
        } as any);
        const jobTemplate = await firstValueFrom(jobsService.newMiningJob$);
        return {
            provider: new TemplateProviderService(jobsService, bitcoinRpcService),
            jobTemplate,
            bitcoinRpcService,
        };
    }

    function createTestTransaction(seed: number): Buffer {
        const tx = new bitcoinjs.Transaction();
        tx.version = 2;
        tx.addInput(Buffer.alloc(32, seed), 0xffffffff, 0xffffffff, Buffer.from([seed & 0xff]));
        tx.addOutput(Buffer.from('6a', 'hex'), 0);
        return tx.toBuffer();
    }

    function createCoinbaseTransaction(script: Buffer): bitcoinjs.Transaction {
        const tx = new bitcoinjs.Transaction();
        tx.version = 2;
        tx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, script);
        tx.addOutput(Buffer.from('6a', 'hex'), 0);
        return tx;
    }

    function createCoinbasePrefixForScript(fullScript: Buffer, prefixScript: Buffer): Buffer {
        const tx = createCoinbaseTransaction(fullScript);
        const serialized = tx.toBuffer();
        const scriptStart = serialized.indexOf(fullScript);
        if (scriptStart < 0) {
            throw new Error('test coinbase script not found');
        }
        return serialized.subarray(0, scriptStart + prefixScript.length);
    }
});
