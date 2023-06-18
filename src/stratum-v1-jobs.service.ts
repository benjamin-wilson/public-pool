import { MiningJob } from './models/MiningJob';


export class StratumV1JobsService {

    public latestJobId: number = 1;

    public jobs: MiningJob[] = [];


    public addJob(job: MiningJob, clearJobs: boolean) {
        if (clearJobs) {
            this.jobs = [];
        }
        this.jobs.push(job);
        this.latestJobId++;
    }

    public getLatestJob() {
        return this.jobs[this.jobs.length - 1];
    }

    public getJobById(jobId: string) {
        return this.jobs.find(job => job.job_id == jobId);
    }

    public getNextId() {
        return this.latestJobId.toString(16);
    }


}