import * as bitcoinjs from 'bitcoinjs-lib';
import { BlocksService } from './blocks.service';

describe('BlocksService', () => {
    it('computes block hash metadata when saving found blocks', async () => {
        const repository = createRepository();
        repository.findOne.mockResolvedValue(null);
        const service = new BlocksService({} as any, repository as any);
        const blockHex = createBlockHex();
        const blockHash = bitcoinjs.Block.fromHex(blockHex).getId();

        await service.save({
            height: 123,
            minerAddress: 'tb1qexample',
            worker: 'worker',
            sessionId: 'abcd1234',
            blockData: blockHex,
            blockSubmissionResult: 'SUCCESS!',
        });

        expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({
            blockHash,
            blockSubmissionResult: 'SUCCESS!',
        }));
    });

    it('does not downgrade an existing successful block on duplicate rejected submissions', async () => {
        const repository = createRepository();
        repository.findOne.mockResolvedValue({
            id: 9,
            blockSubmissionResult: 'SUCCESS!',
            payoutSnapshotId: '7',
            minerAddress: 'tb1qminer',
            worker: 'worker',
            sessionId: 'abcd1234',
        });
        const service = new BlocksService({} as any, repository as any);

        await service.save({
            blockData: createBlockHex(),
            blockSubmissionResult: 'duplicate',
            payoutSnapshotId: '8',
        });

        expect(repository.update).not.toHaveBeenCalled();
        expect(repository.save).not.toHaveBeenCalled();
    });

    it('keeps real miner attribution when a duplicate TDP submit arrives', async () => {
        const repository = createRepository();
        repository.findOne.mockResolvedValue({
            id: 9,
            blockSubmissionResult: 'SUCCESS!',
            payoutSnapshotId: '7',
            minerAddress: 'tb1qminer',
            worker: 'sv2gateway',
            sessionId: 'abcd1234',
        });
        const service = new BlocksService({} as any, repository as any);

        await service.save({
            blockData: createBlockHex(),
            minerAddress: 'tb1qpool',
            worker: 'tdp',
            sessionId: '00000010',
            blockSubmissionResult: 'SUCCESS!',
            payoutSnapshotId: '8',
        });

        expect(repository.update).toHaveBeenCalledWith(9, {
            blockSubmissionResult: 'SUCCESS!',
            payoutSnapshotId: '8',
        });
        expect(repository.save).not.toHaveBeenCalled();
    });

    it('clears payout snapshot metadata when a duplicate successful solo submit arrives', async () => {
        const repository = createRepository();
        repository.findOne.mockResolvedValue({
            id: 9,
            blockSubmissionResult: 'SUCCESS!',
            payoutSnapshotId: '7',
            minerAddress: 'tb1qminer',
            worker: 'worker',
            sessionId: 'abcd1234',
        });
        const service = new BlocksService({} as any, repository as any);

        await service.save({
            blockData: createBlockHex(),
            blockSubmissionResult: 'SUCCESS!',
            payoutSnapshotId: null,
        });

        expect(repository.update).toHaveBeenCalledWith(9, {
            blockSubmissionResult: 'SUCCESS!',
            payoutSnapshotId: null,
        });
        expect(repository.save).not.toHaveBeenCalled();
    });

    it('repairs internal TDP attribution when a duplicate real miner submit arrives', async () => {
        const repository = createRepository();
        repository.findOne.mockResolvedValue({
            id: 9,
            blockSubmissionResult: 'SUCCESS!',
            payoutSnapshotId: '7',
            minerAddress: 'tb1qpool',
            worker: 'tdp',
            sessionId: '00000010',
        });
        const service = new BlocksService({} as any, repository as any);

        await service.save({
            blockData: createBlockHex(),
            minerAddress: 'tb1qminer',
            worker: 'sv2gateway',
            sessionId: 'abcd1234',
            blockSubmissionResult: 'duplicate',
            payoutSnapshotId: '8',
        });

        expect(repository.update).toHaveBeenCalledWith(9, {
            minerAddress: 'tb1qminer',
            worker: 'sv2gateway',
            sessionId: 'abcd1234',
        });
        expect(repository.save).not.toHaveBeenCalled();
    });

    it('returns one public found-block row per block hash or legacy height', async () => {
        const repository = createRepository();
        repository.find.mockResolvedValue([
            { height: 124, minerAddress: 'addr2', worker: 'b', sessionId: '2222', blockHash: 'hash-b' },
            { height: 124, minerAddress: 'addr2', worker: 'b-dup', sessionId: '3333', blockHash: 'hash-b' },
            { height: 123, minerAddress: 'addr1', worker: 'a', sessionId: '1111', blockHash: null },
            { height: 123, minerAddress: 'addr1', worker: 'a-dup', sessionId: '4444', blockHash: null },
        ]);
        const service = new BlocksService({} as any, repository as any);

        await expect(service.getFoundBlocks()).resolves.toEqual([
            { height: 124, minerAddress: 'addr2', worker: 'b', sessionId: '2222', blockHash: 'hash-b' },
            { height: 123, minerAddress: 'addr1', worker: 'a', sessionId: '1111', blockHash: null },
        ]);
        expect(repository.find).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.arrayContaining([
                expect.objectContaining({ blockSubmissionResult: expect.objectContaining({ _value: expect.arrayContaining(['SUCCESS!', 'datum-gateway-submit-expected']) }) }),
                expect.objectContaining({ blockSubmissionResult: expect.objectContaining({ _type: 'isNull' }) }),
            ]),
        }));
    });

    it('includes DATUM gateway-submitted candidates for address found-block lookups', async () => {
        const repository = createRepository();
        repository.find.mockResolvedValue([
            {
                height: 4991348,
                minerAddress: 'tb1qminer',
                worker: 'datum',
                sessionId: '28ff7236',
                blockHash: 'hash-datum',
                blockSubmissionResult: 'datum-gateway-submit-expected',
            },
        ]);
        const service = new BlocksService({} as any, repository as any);

        await expect(service.getFoundBlocksByAddress('tb1qminer')).resolves.toEqual([
            {
                height: 4991348,
                minerAddress: 'tb1qminer',
                worker: 'datum',
                sessionId: '28ff7236',
                blockHash: 'hash-datum',
                blockSubmissionResult: 'datum-gateway-submit-expected',
            },
        ]);
        expect(repository.find).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.arrayContaining([
                expect.objectContaining({
                    minerAddress: 'tb1qminer',
                    blockSubmissionResult: expect.objectContaining({ _value: expect.arrayContaining(['SUCCESS!', 'datum-gateway-submit-expected']) }),
                }),
                expect.objectContaining({
                    minerAddress: 'tb1qminer',
                    blockSubmissionResult: expect.objectContaining({ _type: 'isNull' }),
                }),
            ]),
        }));
    });

    function createRepository() {
        return {
            save: jest.fn().mockResolvedValue(undefined),
            find: jest.fn().mockResolvedValue([]),
            findOne: jest.fn().mockResolvedValue(null),
            update: jest.fn().mockResolvedValue(undefined),
        };
    }

    function createBlockHex(): string {
        const tx = new bitcoinjs.Transaction();
        tx.version = 1;
        tx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x01]));
        tx.addOutput(Buffer.from('6a', 'hex'), 0);

        const block = new bitcoinjs.Block();
        block.version = 1;
        block.prevHash = Buffer.alloc(32);
        block.timestamp = 1;
        block.bits = 0x207fffff;
        block.nonce = 1;
        block.transactions = [tx];
        block.merkleRoot = bitcoinjs.Block.calculateMerkleRoot(block.transactions, false);
        return block.toHex(false);
    }
});
