import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ShareSubmissionsEntity } from './share-submissions.entity';

@Injectable()
export class ShareSubmissionsService {
    constructor(
        @InjectRepository(ShareSubmissionsEntity)
        private shareSubmissionsRepository: Repository<ShareSubmissionsEntity>
    ) {}

    public async insert(shareSubmission: Partial<ShareSubmissionsEntity>) {
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
            .from(ShareSubmissionsEntity)
            .where('time < :time', { time: oneDayAgo.getTime() })
            .execute();
    }

    public async deleteAll() {
        return await this.shareSubmissionsRepository.delete({});
    }
}
