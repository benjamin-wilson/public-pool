import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExternalSharesEntity } from './external-shares.entity';

@Injectable()
export class ExternalSharesService {
    constructor(
        @InjectRepository(ExternalSharesEntity)
        private shareSubmissionsRepository: Repository<ExternalSharesEntity>
    ) {}

    public async insert(shareSubmission: Partial<ExternalSharesEntity>) {
        return await this.shareSubmissionsRepository.insert(shareSubmission);
    }

    public async getTopDifficulties(): Promise<Array<{address: string, difficulty: number}>> {
        return await this.shareSubmissionsRepository
            .createQueryBuilder('share')
            .select('share.address', 'address')
            .addSelect('MAX(share.difficulty)', 'difficulty')
            .groupBy('share.address')
            .orderBy('MAX(share.difficulty)', 'DESC')
            .limit(10)
            .getRawMany();
    }

    public async getAddressBestDifficulty(address: string): Promise<number> {
        const result = await this.shareSubmissionsRepository
            .createQueryBuilder()
            .select('MAX(difficulty)', 'maxDifficulty')
            .where('address = :address', { address })
            .getRawOne();
        return result?.maxDifficulty || 0;
    }

    public async deleteOldSubmissions() {
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        return await this.shareSubmissionsRepository
            .createQueryBuilder()
            .delete()
            .from(ExternalSharesEntity)
            .where('time < :time', { time: oneDayAgo.getTime() })
            .execute();
    }

    public async deleteAll() {
        return await this.shareSubmissionsRepository.delete({});
    }
}
