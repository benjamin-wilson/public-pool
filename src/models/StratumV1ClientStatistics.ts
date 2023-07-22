import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';

const CACHE_SIZE = 30;
const TARGET_SUBMISSION_PER_SECOND = 10;
const MIN_DIFF = 0.000001;
export class StratumV1ClientStatistics {

    private submissionCacheStart: Date;
    private submissionCache = [];

    constructor(private readonly clientStatisticsService: ClientStatisticsService) {
        this.submissionCacheStart = new Date();
    }

    public async addSubmission(client: ClientEntity, submissionHash: string, targetDifficulty: number) {

        if (this.submissionCache.length > CACHE_SIZE) {
            this.submissionCache.shift();
        }

        this.submissionCache.push({
            time: new Date(),
            difficulty: targetDifficulty,
        });

        await this.clientStatisticsService.save({
            time: new Date(),
            difficulty: targetDifficulty,
            address: client.address,
            clientName: client.clientName,
            sessionId: client.sessionId,
            submissionHash
        });

    }
    public getLastSubmissionTime(): Date | null {
        return this.submissionCache[0]?.time;
    }
    public getSuggestedDifficulty(clientDifficulty: number) {

        // miner hasn't submitted shares in one minute
        if (this.submissionCache.length == 0 && (new Date().getTime() - this.submissionCacheStart.getTime()) / 1000 > 60) {
            return this.nearestPowerOfTwo(clientDifficulty >> 1);
        }

        if (this.submissionCache.length < CACHE_SIZE) {
            return null;
        }

        const sum = this.submissionCache.reduce((pre, cur) => {
            pre += cur.difficulty;
            return pre;
        }, 0);
        const diffSeconds = (this.submissionCache[this.submissionCache.length - 1].time.getTime() - this.submissionCache[0].time.getTime()) / 1000;

        const difficultyPerSecond = sum / diffSeconds;

        const targetDifficulty = difficultyPerSecond * TARGET_SUBMISSION_PER_SECOND;

        if (clientDifficulty << 1 < targetDifficulty || clientDifficulty >> 1 > targetDifficulty) {
            return this.nearestPowerOfTwo(targetDifficulty)
        }

        return null;

    }

    private nearestPowerOfTwo(val): number {
        if (val === 0) {
            return null;
        }
        if (val < MIN_DIFF) {
            return MIN_DIFF;
        }
        let x = val | (val >> 1);
        x = x | (x >> 2);
        x = x | (x >> 4);
        x = x | (x >> 8);
        x = x | (x >> 16);
        x = x | (x >> 32);
        const res = x - (x >> 1);
        if (res == 0) {
            return this.nearestPowerOfTwo(val * 100) / 100;
        }
        return res;
    }

}