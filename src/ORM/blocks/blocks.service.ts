import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bitcoinjs from 'bitcoinjs-lib';
import { DataSource, IsNull, Repository } from 'typeorm';

import { BlocksEntity } from './blocks.entity';


@Injectable()
export class BlocksService {

    constructor(

        private dataSource: DataSource,
        @InjectRepository(BlocksEntity)
        private blocksRepository: Repository<BlocksEntity>,
    ) {

    }


    public async save(block: Partial<BlocksEntity>) {
        const blockHash = block.blockHash ?? this.getBlockHash(block.blockData);
        const existing = blockHash == null
            ? null
            : await this.blocksRepository.findOne({
                select: { id: true, blockSubmissionResult: true, payoutSnapshotId: true },
                where: { blockHash },
            });
        if (existing != null) {
            if (this.isSuccessfulBlockSubmission(block.blockSubmissionResult)) {
                await this.blocksRepository.update(existing.id, {
                    blockSubmissionResult: 'SUCCESS!',
                    payoutSnapshotId: block.payoutSnapshotId ?? existing.payoutSnapshotId,
                });
            }
            return;
        }

        await this.blocksRepository.save({
            ...block,
            blockHash,
        });
    }

    public async getFoundBlocks() {
        const rows = await this.blocksRepository.find({
            select: {
                height: true,
                minerAddress: true,
                worker: true,
                sessionId: true,
                blockHash: true,
                blockSubmissionResult: true,
                createdAt: true,
            },
            where: [
                { blockSubmissionResult: 'SUCCESS!' },
                { blockSubmissionResult: IsNull() },
            ],
            order: {
                height: 'DESC',
                createdAt: 'DESC',
            },
        });
        return this.uniqueFoundBlocks(rows);
    }

    public async getFoundBlocksByAddress(address: string) {
        const rows = await this.blocksRepository.find({
            select: {
                height: true,
                minerAddress: true,
                worker: true,
                sessionId: true,
                blockHash: true,
                blockSubmissionResult: true,
                createdAt: true,
            },
            where: [
                { minerAddress: address, blockSubmissionResult: 'SUCCESS!' },
                { minerAddress: address, blockSubmissionResult: IsNull() },
            ],
            order: {
                height: 'DESC',
                createdAt: 'DESC',
            },
        });
        return this.uniqueFoundBlocks(rows);
    }

    private uniqueFoundBlocks(rows: Partial<BlocksEntity>[]): Partial<BlocksEntity>[] {
        const seenBlocks = new Set<string>();
        const seenHeights = new Set<number>();
        return rows.filter(row => {
            if (row.height != null && seenHeights.has(row.height)) {
                return false;
            }
            const key = row.blockHash || `height:${row.height}`;
            if (seenBlocks.has(key)) {
                return false;
            }
            seenBlocks.add(key);
            if (row.height != null) {
                seenHeights.add(row.height);
            }
            return true;
        });
    }

    private getBlockHash(blockData?: string): string | undefined {
        if (blockData == null || blockData.length < 160) {
            return undefined;
        }
        try {
            return bitcoinjs.Block.fromHex(blockData).getId();
        } catch {
            return undefined;
        }
    }

    private isSuccessfulBlockSubmission(result?: string | null): boolean {
        return result == null || result === 'SUCCESS!';
    }
}
