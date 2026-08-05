import { ClientEntity } from '../ORM/client/client.entity';

const CACHE_SIZE = 30;
const DEFAULT_MIN_DIFF = 0.001;
export class StratumV1ClientStatistics {

    public targetSubmitShareEveryNSeconds: number = 30;
    public hashRate = 0;

    private submissionCacheStart: Date;
    private submissionCache: { time: Date, difficulty: number }[] = [];
    private submissionCacheDifficultySum = 0;

    constructor(private readonly minDifficulty = DEFAULT_MIN_DIFF) {
        this.submissionCacheStart = new Date();
    }

    public async addShares(_client: ClientEntity, targetDifficulty: number) {
        var date = new Date();

        if (this.submissionCache.length > CACHE_SIZE) {
            this.submissionCacheDifficultySum -= this.submissionCache[0].difficulty;
            this.submissionCache.shift();
        }
        this.submissionCache.push({
            time: date,
            difficulty: targetDifficulty,
        });
        this.submissionCacheDifficultySum += targetDifficulty;

        const time = new Date().getTime() - this.submissionCache[0].time.getTime();
        if(time > 60000 && this.submissionCache.length > 2) { 
            this.hashRate = (this.submissionCacheDifficultySum * 4294967296) / (time / 1000);
        }
    }


    public getSuggestedDifficulty(clientDifficulty: number) {

        // miner hasn't submitted shares in one minute
        if (this.submissionCache.length < 5) {
            if ((new Date().getTime() - this.submissionCacheStart.getTime()) / 5000 > 60) {
                return this.nearestPowerOfTwo(clientDifficulty / 6);
            } else {
                return null;
            }
        }

        const sum = this.submissionCache.reduce((pre, cur) => {
            pre += cur.difficulty;
            return pre;
        }, 0);
        const diffSeconds = (this.submissionCache[this.submissionCache.length - 1].time.getTime() - this.submissionCache[0].time.getTime()) / 1000;
        if (!Number.isFinite(diffSeconds) || diffSeconds <= 0) {
            return null;
        }

        const difficultyPerSecond = sum / diffSeconds;

        const targetDifficulty = difficultyPerSecond * this.targetSubmitShareEveryNSeconds;
        if (!Number.isFinite(targetDifficulty) || targetDifficulty <= 0) {
            return null;
        }

        if ((clientDifficulty * 2) < targetDifficulty || (clientDifficulty / 2) > targetDifficulty) {
            return this.nearestPowerOfTwo(targetDifficulty)
        }

        return null;
    }

    private nearestPowerOfTwo(val: number): number {
        if (!Number.isFinite(val) || val <= 0) {
            return null;
        }
        if (val <= this.minDifficulty) {
            return this.minDifficulty;
        }
        const result = 2 ** Math.floor(Math.log2(val));
        return Number.isFinite(result) ? Math.max(this.minDifficulty, result) : null;
    }

}
