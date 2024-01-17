import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { HomeGraphEntity } from './home-graph.entity';

@Injectable()
export class HomeGraphService {
    constructor(
        @InjectRepository(HomeGraphEntity) private homeGraphRepository: Repository<HomeGraphEntity>
    ) {

    }

    public async getLatestTime(): Promise<Date> {
        const result = await this.homeGraphRepository.createQueryBuilder('entity')
            .select('MAX(entity.label)', 'maxNumber')
            .getRawOne();

        if (result.maxNumber == null) {
            return new Date(new Date().getTime() - (24 * 60 * 60 * 1000));
        }

        return new Date(parseInt(result.maxNumber));
    }

    public async save(graph: { label: number, data: number }[]) {
        await this.homeGraphRepository.insert(graph);
    }

    public async getChartDataForSite(limit: number = 144 * 7) {
        const records = await this.homeGraphRepository
            .createQueryBuilder('homeGraph')
            .orderBy('homeGraph.id', 'DESC')
            .limit(limit)
            .getRawMany();

        return records.map(res => {
            return {
                label: new Date(parseInt(res.homeGraph_label)).toISOString(),
                data: res.homeGraph_data
            }
        });
    }
}