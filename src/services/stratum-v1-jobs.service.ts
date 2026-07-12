import { Injectable } from '@nestjs/common';
import * as bitcoinjs from 'bitcoinjs-lib';
import * as crypto from 'crypto';
import { EMPTY, filter, map, merge, Observable, shareReplay, tap } from 'rxjs';

import { IBlockTemplate, IBlockTemplateTx } from '../models/bitcoin-rpc/IBlockTemplate';
import { AddressObject, MiningJob } from '../models/MiningJob';
import { PayoutMode } from '../types/payout-mode';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import {
    createPreparedMiningJob,
    PreparedMiningJobBodyReference,
} from './prepared-mining-job.factory';

export interface IJobTemplate {

    block: bitcoinjs.Block;
    merkle_branch: string[];
    blockData: {
        id: string,
        creation: number,
        coinbasevalue: number;
        networkDifficulty: number;
        height: number;
        tipKey: string;
        clearJobs: boolean;
        isNewBlock: boolean;
        jobType: 'full' | 'empty';
        payoutMode: PayoutMode | 'all';
        notificationEventId?: string;
        notificationPublishedAtMs?: number;
        payoutSnapshotId?: string;
        payoutOutputs?: AddressObject[];
        transactions?: IBlockTemplateTx[];
        bodyReference?: PreparedMiningJobBodyReference;
        sigoplimit?: number;
        sizelimit?: number;
        weightlimit?: number;
        requiredVersionBits?: number;
    };
}

export interface IJobSubmissionContext {
    job: MiningJob;
    jobTemplate: IJobTemplate;
    status: 'current' | 'stale';
}

const DEFAULT_JOB_RETENTION_MS = 5 * 60 * 1000;
const PAYOUT_MODES: readonly PayoutMode[] = ['solo', 'pplns'];

export function createPayoutOutputIdentity(
    payoutMode: PayoutMode,
    payoutInformation: readonly AddressObject[],
): string {
    const fingerprint = crypto.createHash('sha256')
        .update(JSON.stringify(payoutInformation.map(output => ({
            address: output.address,
            amountSats: output.amountSats ?? null,
            percent: output.percent ?? null,
        }))))
        .digest('hex');
    return `${payoutMode}\0outputs\0${fingerprint}`;
}

@Injectable()
export class StratumV1JobsService {

    public newMiningJob$: Observable<IJobTemplate>;
    /** Ordered SV1-only stream: subsidy bridge first, canonical full job second. */
    public sv1MiningJob$: Observable<IJobTemplate>;
    public latestJobId: number = 1;
    public latestJobTemplateId: number = 1;
    public jobs: { [jobId: string]: MiningJob } = {};
    public blocks: { [id: number]: IJobTemplate } = {};

    private readonly lastPreviousBlockHashes = new Map<PayoutMode, string>();
    private readonly lastWorkSignatures = new Map<PayoutMode, string>();
    private readonly currentTipKeys = new Map<PayoutMode, string>();
    private readonly cachedJobs = new Map<string, MiningJob>();
    private readonly latestJobTemplates = new Map<PayoutMode | 'all', IJobTemplate>();
    private readonly pinnedCurrentTipTemplateIds = new Map<PayoutMode, Set<string>>([
        ['solo', new Set<string>()],
        ['pplns', new Set<string>()],
    ]);

    constructor(
        private readonly bitcoinRpcService: BitcoinRpcService
    ) {

        const createMiningJobStream = (blockTemplates: Observable<IBlockTemplate>) => blockTemplates.pipe(
            map((blockTemplate) => {

                if (process.env.MASTER == 'true') {
                    console.log('Updating block template');
                }

                const prepared = createPreparedMiningJob(blockTemplate);
                const payoutModes = this.getAffectedPayoutModes(prepared.payoutMode);
                const isNewBlock = payoutModes.some(payoutMode =>
                    this.lastPreviousBlockHashes.get(payoutMode) == null
                    || this.lastPreviousBlockHashes.get(payoutMode) !== prepared.header.previousBlockHash,
                );
                const clearJobs = isNewBlock || prepared.forceCleanJobs;

                if(isNewBlock){
                    console.log('New template is new block, clearing jobs');
                    payoutModes.forEach(payoutMode => {
                        this.lastPreviousBlockHashes.set(
                            payoutMode,
                            prepared.header.previousBlockHash,
                        );
                    });
                }

                const currentTime = Math.floor(new Date().getTime() / 1000);
                const timestamp = Math.max(
                    prepared.header.minTime,
                    currentTime,
                );
                const workSignature = [
                    prepared.tipKey,
                    prepared.header.version,
                    prepared.header.bitsHex,
                    timestamp,
                    prepared.coinbase.valueSats,
                    prepared.coinbase.payoutSnapshotId ?? '',
                    ...(prepared.coinbase.payoutOutputs ?? []).map(output => [
                        output.address,
                        output.amountSats ?? '',
                        output.percent ?? ''
                    ].join(':')),
                    prepared.body.reference,
                    ...prepared.coinbase.merkleBranch,
                ].join('|');

                if (!clearJobs && payoutModes.every(payoutMode =>
                    this.lastWorkSignatures.get(payoutMode) === workSignature,
                )) {
                    return null;
                }
                payoutModes.forEach(payoutMode => {
                    this.lastWorkSignatures.set(payoutMode, workSignature);
                });

                return {
                    prepared,
                    timestamp,
                    networkDifficulty: this.calculateNetworkDifficulty(prepared.header.bits),
                    clearJobs,
                    isNewBlock,
                    notificationEventId: blockTemplate.notificationEventId,
                    notificationPublishedAtMs: blockTemplate.notificationPublishedAtMs,
                    rawTransactions: blockTemplate.transactions,
                    sigoplimit: blockTemplate.sigoplimit,
                    sizelimit: blockTemplate.sizelimit,
                    weightlimit: blockTemplate.weightlimit,
                    requiredVersionBits: blockTemplate.vbrequired >>> 0,
                };
            }),
            filter(next => next != null),
            map(({ prepared, timestamp, networkDifficulty, clearJobs, isNewBlock, notificationEventId, notificationPublishedAtMs, rawTransactions, sigoplimit, sizelimit, weightlimit, requiredVersionBits }) => {
                const block = new bitcoinjs.Block();

                // Keep only a placeholder coinbase on the hot path. The full raw body
                // remains in blockData and is parsed only for a block candidate.
                const tempCoinbaseTx = new bitcoinjs.Transaction();
                tempCoinbaseTx.version = 2;
                tempCoinbaseTx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
                tempCoinbaseTx.ins[0].witness = [Buffer.alloc(32, 0)];
                const merkle_branch = [...prepared.coinbase.merkleBranch];

                block.prevHash = Buffer.from(prepared.header.previousBlockHashLE, 'hex');
                block.version = prepared.header.version;
                block.bits = prepared.header.bits;
                block.timestamp = timestamp;
                block.transactions = [tempCoinbaseTx];
                block.merkleRoot = MiningJob.calculateMerkleRootFromCoinbaseHash(
                    tempCoinbaseTx.getHash(false),
                    merkle_branch.map(branch => Buffer.from(branch, 'hex')),
                );
                block.witnessCommit = Buffer.from(prepared.coinbase.witnessCommitmentHash, 'hex');

                const id = this.getNextTemplateId();
                this.latestJobTemplateId++;
                return {
                    block,
                    merkle_branch,
                    blockData: {
                        id,
                        creation: new Date().getTime(),
                        coinbasevalue: prepared.coinbase.valueSats,
                        networkDifficulty,
                        height: prepared.height,
                        tipKey: prepared.tipKey,
                        clearJobs,
                        isNewBlock,
                        jobType: prepared.jobType,
                        payoutMode: prepared.payoutMode,
                        notificationEventId,
                        notificationPublishedAtMs,
                        payoutSnapshotId: prepared.coinbase.payoutSnapshotId,
                        payoutOutputs: prepared.coinbase.payoutOutputs?.map(output => ({ ...output })),
                        transactions: rawTransactions,
                        bodyReference: prepared.body,
                        sigoplimit,
                        sizelimit,
                        weightlimit,
                        requiredVersionBits,
                    }
                }
            }),
            tap((data) => {
                this.blocks[data.blockData.id] = data;
                this.getAffectedPayoutModes(data.blockData.payoutMode).forEach(payoutMode => {
                    const pinnedTemplateIds = this.pinnedCurrentTipTemplateIds.get(payoutMode);
                    if (this.currentTipKeys.get(payoutMode) !== data.blockData.tipKey) {
                        pinnedTemplateIds.clear();
                    }
                    this.currentTipKeys.set(payoutMode, data.blockData.tipKey);
                    if (data.blockData.clearJobs) {
                        // ESP-class miners only switch on clean work. Keep each mode's
                        // bridge and clean full replacement reconstructable for its tip.
                        pinnedTemplateIds.add(data.blockData.id);
                    }
                });
                this.latestJobTemplates.set(data.blockData.payoutMode, data);
                if (data.blockData.payoutMode === 'all') {
                    this.latestJobTemplates.set('solo', data);
                    this.latestJobTemplates.set('pplns', data);
                }
                this.cleanupExpiredJobsAndTemplates();
            }),
            shareReplay({ refCount: true, bufferSize: 1 })
        );

        this.newMiningJob$ = createMiningJobStream(this.bitcoinRpcService.newBlockTemplate$);
        const bridgeMiningJob$ = createMiningJobStream(
            this.bitcoinRpcService.newSv1BridgeTemplate$ ?? EMPTY,
        );
        this.sv1MiningJob$ = merge(bridgeMiningJob$, this.newMiningJob$).pipe(
            shareReplay({ refCount: true, bufferSize: 1 }),
        );

        if (process.env.API_ONLY !== 'true' && process.env.MASTER !== 'true') {
            this.sv1MiningJob$.subscribe();
        }
    }

    private calculateNetworkDifficulty(nBits: number) {
        const mantissa: number = nBits & 0x007fffff;       // Extract the mantissa from nBits
        const exponent: number = (nBits >> 24) & 0xff;       // Extract the exponent from nBits

        const target: number = mantissa * Math.pow(256, (exponent - 3));   // Calculate the target value

        const maxTarget = Math.pow(2, 208) * 65535; // Easiest target (max_target)
        const difficulty: number = maxTarget / target;    // Calculate the difficulty

        return difficulty;
    }

    public getJobTemplateById(jobTemplateId: string): IJobTemplate | null {
        return this.blocks[jobTemplateId];
    }

    public getLatestJobTemplate(payoutMode: PayoutMode): IJobTemplate | null {
        return this.latestJobTemplates.get(payoutMode)
            ?? this.latestJobTemplates.get('all')
            ?? null;
    }

    public addJob(job: MiningJob) {
        this.jobs[job.jobId] = job;
        this.latestJobId++;
    }

    public getOrCreateJob(
        network: bitcoinjs.networks.Network,
        payoutInformation: AddressObject[],
        jobTemplate: IJobTemplate,
        payoutIdentity?: string,
        payoutMode?: PayoutMode,
    ): MiningJob {
        const effectivePayoutMode = payoutMode
            ?? (jobTemplate.blockData.payoutMode === 'pplns' ? 'pplns' : 'solo');
        const effectivePayoutIdentity = payoutIdentity
            ?? createPayoutOutputIdentity(effectivePayoutMode, payoutInformation);
        const cacheKey = [
            jobTemplate.blockData.id,
            jobTemplate.block.timestamp,
            jobTemplate.blockData.clearJobs,
            effectivePayoutMode,
            effectivePayoutIdentity,
        ].join(':');
        const cached = this.cachedJobs.get(cacheKey);
        if (cached != null) {
            return cached;
        }

        const job = new MiningJob(
            network,
            this.getNextId(),
            payoutInformation,
            jobTemplate,
            {
                payoutMode: effectivePayoutMode,
                payoutIdentity: effectivePayoutIdentity,
            },
        );
        this.addJob(job);
        this.cachedJobs.set(cacheKey, job);
        return job;
    }

    public getJobById(jobId: string) {
        return this.jobs[jobId];
    }

    public getSubmissionContext(jobId: string): IJobSubmissionContext | null {
        const job = this.jobs[jobId];
        if (job == null) {
            return null;
        }

        const jobTemplate = this.blocks[job.jobTemplateId];
        if (jobTemplate == null) {
            return null;
        }

        return {
            job,
            jobTemplate,
            status: this.getJobPayoutModes(job, jobTemplate).some(payoutMode =>
                job.tipKey === this.currentTipKeys.get(payoutMode),
            ) ? 'current' : 'stale',
        };
    }

    public getNextTemplateId() {
        return this.latestJobTemplateId.toString(16);
    }
    public getNextId() {
        return this.latestJobId.toString(16);
    }

    private cleanupExpiredJobsAndTemplates() {
        const cutoff = Date.now() - this.getJobRetentionMs();
        const protectedTemplateIds = new Set<string>();
        for (const payoutMode of PAYOUT_MODES) {
            this.pinnedCurrentTipTemplateIds.get(payoutMode)
                .forEach(templateId => protectedTemplateIds.add(templateId));
            const latestTemplate = this.latestJobTemplates.get(payoutMode);
            if (latestTemplate != null) {
                protectedTemplateIds.add(latestTemplate.blockData.id);
            }
        }

        for (const jobId in this.jobs) {
            if (this.jobs[jobId].creation < cutoff
                && !this.isJobProtected(this.jobs[jobId], protectedTemplateIds)) {
                delete this.jobs[jobId];
            }
        }

        const retainedTemplateIds = new Set(
            Object.values(this.jobs).map(job => job.jobTemplateId),
        );
        protectedTemplateIds.forEach(templateId => retainedTemplateIds.add(templateId));

        for (const templateId in this.blocks) {
            if (this.blocks[templateId].blockData.creation < cutoff
                && !retainedTemplateIds.has(templateId)) {
                delete this.blocks[templateId];
            }
        }

        for (const [cacheKey, job] of this.cachedJobs.entries()) {
            if (this.jobs[job.jobId] !== job || this.blocks[job.jobTemplateId] == null) {
                this.cachedJobs.delete(cacheKey);
            }
        }
    }

    private getAffectedPayoutModes(payoutMode: PayoutMode | 'all'): readonly PayoutMode[] {
        return payoutMode === 'all' ? PAYOUT_MODES : [payoutMode];
    }

    private getJobPayoutModes(job: MiningJob, jobTemplate: IJobTemplate): readonly PayoutMode[] {
        if (job.ownership?.payoutMode != null) {
            return [job.ownership.payoutMode];
        }
        return this.getAffectedPayoutModes(jobTemplate.blockData.payoutMode);
    }

    private isJobProtected(job: MiningJob, legacyProtectedTemplateIds: ReadonlySet<string>): boolean {
        const payoutMode = job.ownership?.payoutMode;
        if (payoutMode == null) {
            return legacyProtectedTemplateIds.has(job.jobTemplateId);
        }
        return this.pinnedCurrentTipTemplateIds.get(payoutMode).has(job.jobTemplateId)
            || this.latestJobTemplates.get(payoutMode)?.blockData.id === job.jobTemplateId;
    }

    private getJobRetentionMs(): number {
        const configured = Number(process.env.STRATUM_JOB_RETENTION_MS);
        return Number.isInteger(configured) && configured > 0
            ? configured
            : DEFAULT_JOB_RETENTION_MS;
    }

}
