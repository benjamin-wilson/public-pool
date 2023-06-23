export class StratumV1ClientStatistics {

    public bestDifficulty: number = 0;

    public historicSubmissions = [];

    constructor() {

    }

    public addSubmission(targetDifficulty: number, submissionDifficulty: number, networkDifficulty: number) {

        if (this.historicSubmissions.length >= 1000) {
            this.historicSubmissions.shift();
        }

        this.historicSubmissions.push({
            difficulty: targetDifficulty,
            time: new Date()
        });

        if (submissionDifficulty > this.bestDifficulty) {
            this.bestDifficulty = submissionDifficulty;
        }
    }

    public getHashRate() {
        return this.historicSubmissions.reduce((pre, cur, idx, arr) => {
            if (idx === 0) {
                pre.time = cur.time;
            }
            pre.difficulty += cur.difficulty;

            if (arr.length - 1 === idx) {
                const duration = cur.time.getTime() - pre.time.getTime();
                const sumDifficulty = pre.difficulty;
                return (sumDifficulty * 4294967296) / (duration * 1000000)
            }
            return pre;
        }, {
            difficulty: 0,
            time: undefined
        })
    }
}