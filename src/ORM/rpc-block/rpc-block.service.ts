import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InsertResult, Repository } from 'typeorm';

import { RpcBlockEntity } from './rpc-block.entity';

@Injectable()
export class RpcBlockService {
    constructor(
        @InjectRepository(RpcBlockEntity)
        private rpcBlockRepository: Repository<RpcBlockEntity>
    ) {

    }
    public getSavedBlockTemplate(blockHeight: number) {
        return this.rpcBlockRepository.findOne({
            where: { blockHeight }
        });
    }

    public saveBlock(blockHeight: number, data: string): Promise<InsertResult> {
        return this.rpcBlockRepository.upsert({ blockHeight, data }, ['blockHeight']);
    }

    public async deleteOldBlocks() {
        const result = await this.rpcBlockRepository.createQueryBuilder('entity')
            .select('MAX(entity.blockHeight)', 'maxNumber')
            .getRawOne();

        const newestBlock = result ? result.maxNumber : null;

        await this.rpcBlockRepository.createQueryBuilder()
            .delete()
            .where('"blockHeight" < :newestBlock', { newestBlock })
            .execute();

        return;
    }
}