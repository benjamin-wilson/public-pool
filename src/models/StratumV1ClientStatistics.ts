import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';

export class StratumV1ClientStatistics {


    constructor(private readonly clientStatisticsService: ClientStatisticsService) {

    }

    public async addSubmission(client: ClientEntity, targetDifficulty: number) {

        await this.clientStatisticsService.save({
            time: new Date(),
            difficulty: targetDifficulty,
            client
        });

    }


}