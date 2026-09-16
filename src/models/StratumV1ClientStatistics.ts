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
        const date = new Date();

        if (this.submissionCache.length >= CACHE_SIZE) {
            this.submissionCacheDifficultySum -= this.submissionCache[0].difficulty;
            this.submissionCache.shift();
        }
        this.submissionCache.push({
            time: date,
            difficulty: targetDifficulty,
        });
        this.submissionCacheDifficultySum += targetDifficulty;

        const elapsedSeconds = (date.getTime() - this.submissionCache[0].time.getTime()) / 1000;
        if (elapsedSeconds > 60) {
            const difficultyPerSecond = this.getDifficultyPerSecond(elapsedSeconds);
            if (difficultyPerSecond != null) {
                this.hashRate = difficultyPerSecond * 4294967296;
            }
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

        const diffSeconds = (this.submissionCache[this.submissionCache.length - 1].time.getTime() - this.submissionCache[0].time.getTime()) / 1000;
        const difficultyPerSecond = this.getDifficultyPerSecond(diffSeconds);
        if (difficultyPerSecond == null) {
            return null;
        }

        const targetDifficulty = difficultyPerSecond * this.targetSubmitShareEveryNSeconds;
        if (!Number.isFinite(targetDifficulty) || targetDifficulty <= 0) {
            return null;
        }

        if ((clientDifficulty * 2) < targetDifficulty || (clientDifficulty / 2) > targetDifficulty) {
            return this.nearestPowerOfTwo(targetDifficulty)
        }

        return null;
    }

    /**
     * Estimate work rate from a share-terminated sample window.
     *
     * A cache of N shares contains N - 1 observed inter-share intervals. The
     * first share's work predates the window and must not be counted. Because
     * the window closes on a share arrival, the reciprocal elapsed time also
     * has the usual finite-sample Poisson bias; multiplying by
     * (intervalCount - 1) / intervalCount removes it.
     */
    private getDifficultyPerSecond(elapsedSeconds: number): number | null {
        const sampleCount = this.submissionCache.length;
        if (sampleCount <= 2 || !Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
            return null;
        }

        const intervalCount = sampleCount - 1;
        const observedDifficulty = this.submissionCacheDifficultySum
            - this.submissionCache[0].difficulty;
        const unbiasedDifficulty = observedDifficulty * (intervalCount - 1) / intervalCount;
        const difficultyPerSecond = unbiasedDifficulty / elapsedSeconds;

        return Number.isFinite(difficultyPerSecond) && difficultyPerSecond > 0
            ? difficultyPerSecond
            : null;
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
