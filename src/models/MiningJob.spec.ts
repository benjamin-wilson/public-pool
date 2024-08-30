import { ConfigService } from "@nestjs/config";
import * as bitcoinjs from 'bitcoinjs-lib';
import { Test, TestingModule } from "@nestjs/testing";
import { MiningJob } from "./MiningJob";
import { IJobTemplate } from "../services/stratum-v1-jobs.service";


function hexToAscii(hex: string): string {
    let ascii = '';
    for (let i = 0; i < hex.length; i += 2) {
        const char = String.fromCharCode(parseInt(hex.substr(i, 2), 16));
        if (char !== '\0') {  // Ignore null characters to make sure string matching works
            ascii += char;
        }
    }
    return ascii;
}

function extractPoolIdentifierFromScript(coinbaseHex: string) {
    let offset = 8 + 2 + 64 + 8;  // Skip Version, Input Count, Previous Transaction Hash, Previous Output Index

    // Coinbase Data Length (1 byte / 2 hex characters)
    const coinbaseDataLengthHex = coinbaseHex.substr(offset, 2);
    const coinbaseDataLength = parseInt(coinbaseDataLengthHex, 16);
    offset += 2;

    // Coinbase Data (coinbaseDataLength * 2 hex characters)
    const coinbaseDataHex = coinbaseHex.substr(offset, coinbaseDataLength * 2);

    const coinbaseDataAscii = hexToAscii(coinbaseDataHex);

    return coinbaseDataAscii;
}

describe('MiningJob', () => {
    let moduleRef: TestingModule;
    let configService: ConfigService;
    let block: bitcoinjs.Block;
    let jobTemplate: IJobTemplate;
    let payoutInformation: any[];


    beforeAll(async () => {
        moduleRef = await Test.createTestingModule({
            providers: [
                {
                    provide: ConfigService,
                    useValue: {
                        get: jest.fn((key: string) => {
                            switch (key) {
                                // Configure mock responses for ConfigService
                            }
                            return null;
                        })
                    }
                }
            ],
        }).compile();
        configService = moduleRef.get<ConfigService>(ConfigService);
    });


    describe('constructor', () => {
        beforeEach(() => {

            console.warn = jest.fn((message: string) => console.log('WARN:', message));
            payoutInformation = [
                {
                    address: 'tb1qr2ylpdgp9ejpt6v2uxlqrn9penp82rzz2grnns',
                    percent: 100,
                }
            ];
            block = new bitcoinjs.Block();
            block.witnessCommit = Buffer.from('000');
            block.prevHash = Buffer.from('000');
            block.merkleRoot = Buffer.from('000');
            block.transactions = [];

            const maxTransactions = 7545; // this is only for block weight calculation, other metrics like operations are not considered because they are not affected by the size of the pool identifier
            for (let i = 0; i < maxTransactions; i++) {
                block.transactions.push(bitcoinjs.Transaction.fromHex("010000000001017405e391018c5e9dc79f324f9607c9c46d21b02f66dabaa870b4add871d6379f01000000171600148d7a0a3461e3891723e5fdf8129caa0075060cffffffffff01fcf60200000000001600148d7a0a3461e3891723e5fdf8129caa0075060cff0248304502210088025cffdaf69d310c6fed11832edd9c19b6a912c132262701ad0e6133227d9202207d73bbf777abd2aeae995d684e6bb1a048c5ac722e16de48bdd35643df7decf001210283409659355b6d1cc3c32decd5d561abaac86c37a353b52895a5e6c196d6f44800000000"));
            }

            jobTemplate = {
                block: block,
                blockData: {
                    id: '1',
                    coinbasevalue: 0,
                    networkDifficulty: 0,
                    height: 0,
                    clearJobs: false,
                }
            } as IJobTemplate;
        });
        it('should create a new MiningJob if POOL_IDENTIFIER is not set and use the default', () => {
            const expectedMiningIdentifier = 'Public-Pool';
            expect(jobTemplate.block).toBeDefined();
            const miningJob = new MiningJob(configService, bitcoinjs.networks.testnet, '1', payoutInformation, jobTemplate);

            const response = JSON.parse(miningJob.response(jobTemplate));

            const miningIdentifier = extractPoolIdentifierFromScript(response.params[2]);
            expect(miningIdentifier).toBe(expectedMiningIdentifier);
            expect(console.warn).not.toBeCalled();
        });

        it('should use the POOL_IDENTIFIER if it doesn\'t make the script size too big', () => {
            const expectedMiningIdentifier = 'My Mining Pool';

            configService.get = jest.fn((key: string) => {
                switch (key) {
                    case 'POOL_IDENTIFIER': return expectedMiningIdentifier;
                }
                return null;
            });

            const miningJob = new MiningJob(configService, bitcoinjs.networks.testnet, '1', payoutInformation, jobTemplate);
            const response = JSON.parse(miningJob.response(jobTemplate));

            const miningIdentifier = extractPoolIdentifierFromScript(response.params[2]);
            expect(miningIdentifier).toBe(expectedMiningIdentifier);
            expect(console.warn).not.toBeCalled();

        });

        it('should remove pool identifier if block is too big with identifier', () => {
            const expectedMiningIdentifier = '';

            configService.get = jest.fn((key: string) => {
                switch (key) {
                    case 'POOL_IDENTIFIER': return 'A'.repeat(84);
                }
                return null;
            });

            const miningJob = new MiningJob(configService, bitcoinjs.networks.testnet, '1', payoutInformation, jobTemplate);
            const response = JSON.parse(miningJob.response(jobTemplate));

            const miningIdentifier = extractPoolIdentifierFromScript(response.params[2]);
            expect(console.warn).toBeCalledWith('Block weight exceeds the maximum allowed weight, removing the pool identifier');
            expect(miningIdentifier).toBe(expectedMiningIdentifier);
        });

        it('should use the POOL_IDENTIFIER if it doesn\'t make the script size too big with identifier abcabc', () => {

            jobTemplate.block.transactions = []; // remove transactions because we only want to test the script size
            const expectedMiningIdentifier = 'A'.repeat(88); // 88 chars is the maximum size validated against bitcoin core in regtest
            configService.get = jest.fn((key: string) => {
                switch (key) {
                    case 'POOL_IDENTIFIER': return expectedMiningIdentifier;
                }
                return null;
            });

            const miningJob = new MiningJob(configService, bitcoinjs.networks.testnet, '1', payoutInformation, jobTemplate);
            const response = JSON.parse(miningJob.response(jobTemplate));

            const miningIdentifier = extractPoolIdentifierFromScript(response.params[2]);
            expect(miningIdentifier).toBe(expectedMiningIdentifier);
            expect(console.warn).not.toBeCalled();
        });

        it('should remove pool identifier if script is too big with identifier', () => {
            const expectedMiningIdentifier = '';
            jobTemplate.block.transactions = []; // remove transactions because we only want to test the script size
            configService.get = jest.fn((key: string) => {
                switch (key) {
                    case 'POOL_IDENTIFIER': return 'A'.repeat(89); // 88 chars is the maximum size validated against bitcoin core in regtest
                }
                return null;
            });

            const miningJob = new MiningJob(configService, bitcoinjs.networks.testnet, '1', payoutInformation, jobTemplate);
            const response = JSON.parse(miningJob.response(jobTemplate));

            const miningIdentifier = extractPoolIdentifierFromScript(response.params[2]);
            expect(console.warn).toBeCalledWith('Pool identifier is too long, removing the pool identifier');
            expect(miningIdentifier).toBe(expectedMiningIdentifier);
        });
    });
});
