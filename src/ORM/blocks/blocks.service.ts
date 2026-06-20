import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bitcoinjs from 'bitcoinjs-lib';
import { DataSource, In, IsNull, Repository } from 'typeorm';

import { BlocksEntity } from './blocks.entity';
import { PayoutMode } from '../../types/payout-mode';


@Injectable()
export class BlocksService {

    private static readonly PUBLIC_FOUND_BLOCK_RESULTS = ['SUCCESS!', 'datum-gateway-submit-expected'];

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
                select: {
                    id: true,
                    blockSubmissionResult: true,
                    payoutSnapshotId: true,
                    minerAddress: true,
                    worker: true,
                    sessionId: true,
                    payoutMode: true,
                },
                where: { blockHash },
            });
        if (existing != null) {
            const update: Partial<BlocksEntity> = {};
            if (this.isSuccessfulBlockSubmission(block.blockSubmissionResult)) {
                update.blockSubmissionResult = 'SUCCESS!';
                update.payoutSnapshotId = Object.prototype.hasOwnProperty.call(block, 'payoutSnapshotId')
                    ? block.payoutSnapshotId ?? null
                    : existing.payoutSnapshotId;
            }
            if (this.shouldReplaceAttribution(existing, block)) {
                update.minerAddress = block.minerAddress;
                update.worker = block.worker;
                update.sessionId = block.sessionId;
            }
            if (block.payoutMode != null && existing.payoutMode !== block.payoutMode) {
                update.payoutMode = block.payoutMode;
            }
            if (Object.keys(update).length > 0) {
                await this.blocksRepository.update(existing.id, update);
            }
            return;
        }

        await this.blocksRepository.save({
            ...block,
            blockHash,
        });
    }

    public async getFoundBlocks(payoutMode?: PayoutMode) {
        const rows = await this.blocksRepository.find({
            select: {
                height: true,
                minerAddress: true,
                worker: true,
                sessionId: true,
                payoutMode: true,
                blockHash: true,
                blockSubmissionResult: true,
                createdAt: true,
            },
            where: [
                { ...(payoutMode == null ? {} : { payoutMode }), blockSubmissionResult: In(BlocksService.PUBLIC_FOUND_BLOCK_RESULTS) },
                { ...(payoutMode == null ? {} : { payoutMode }), blockSubmissionResult: IsNull() },
            ],
            order: {
                height: 'DESC',
                createdAt: 'DESC',
            },
        });
        return this.uniqueFoundBlocks(rows);
    }

    public async getFoundBlocksByAddress(address: string, payoutMode?: PayoutMode) {
        const rows = await this.blocksRepository.find({
            select: {
                height: true,
                minerAddress: true,
                worker: true,
                sessionId: true,
                payoutMode: true,
                blockHash: true,
                blockSubmissionResult: true,
                createdAt: true,
            },
            where: [
                { minerAddress: address, ...(payoutMode == null ? {} : { payoutMode }), blockSubmissionResult: In(BlocksService.PUBLIC_FOUND_BLOCK_RESULTS) },
                { minerAddress: address, ...(payoutMode == null ? {} : { payoutMode }), blockSubmissionResult: IsNull() },
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

    private shouldReplaceAttribution(existing: Partial<BlocksEntity>, incoming: Partial<BlocksEntity>): boolean {
        if (!incoming.minerAddress || !incoming.worker) {
            return false;
        }
        if (this.isInternalAttribution(incoming)) {
            return false;
        }
        return this.isInternalAttribution(existing);
    }

    private isInternalAttribution(block: Partial<BlocksEntity>): boolean {
        const worker = block.worker?.toLowerCase();
        return worker === 'tdp' || block.minerAddress === 'sv2-tdp';
    }
}
