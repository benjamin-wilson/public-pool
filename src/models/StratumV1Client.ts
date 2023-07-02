import Big from 'big.js';
import { plainToInstance } from 'class-transformer';
import { validate, ValidatorOptions } from 'class-validator';
import * as crypto from 'crypto';
import { Socket } from 'net';
import PromiseSocket from 'promise-socket';
import { combineLatest, firstValueFrom, interval, startWith, takeUntil } from 'rxjs';

import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { BlockTemplateService } from '../services/block-template.service';
import { StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { EasyUnsubscribe } from '../utils/EasyUnsubscribe';
import { IBlockTemplate } from './bitcoin-rpc/IBlockTemplate';
import { eRequestMethod } from './enums/eRequestMethod';
import { eResponseMethod } from './enums/eResponseMethod';
import { eStratumErrorCode } from './enums/eStratumErrorCode';
import { MiningJob } from './MiningJob';
import { AuthorizationMessage } from './stratum-messages/AuthorizationMessage';
import { ConfigurationMessage } from './stratum-messages/ConfigurationMessage';
import { MiningSubmitMessage } from './stratum-messages/MiningSubmitMessage';
import { StratumErrorMessage } from './stratum-messages/StratumErrorMessage';
import { SubscriptionMessage } from './stratum-messages/SubscriptionMessage';
import { SuggestDifficulty } from './stratum-messages/SuggestDifficultyMessage';
import { StratumV1ClientStatistics } from './StratumV1ClientStatistics';

export class StratumV1Client extends EasyUnsubscribe {

    private clientSubscription: SubscriptionMessage;
    private clientConfiguration: ConfigurationMessage;
    private clientAuthorization: AuthorizationMessage;
    private clientSuggestedDifficulty: SuggestDifficulty;

    private statistics: StratumV1ClientStatistics;
    private stratumInitialized = false;
    private usedSuggestedDifficulty = false;
    private sessionDifficulty: number = 32768;
    private entity: ClientEntity;

    public extraNonce: string;

    constructor(
        public readonly promiseSocket: PromiseSocket<Socket>,
        private readonly stratumV1JobsService: StratumV1JobsService,
        private readonly blockTemplateService: BlockTemplateService,
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService
    ) {
        super();

        this.statistics = new StratumV1ClientStatistics(this.clientStatisticsService);
        this.extraNonce = this.getRandomHexString();

        console.log(`New client ID: : ${this.extraNonce}`);

        this.promiseSocket.socket.on('data', (data: Buffer) => {
            data.toString()
                .split('\n')
                .filter(m => m.length > 0)
                .forEach(m => this.handleMessage(m))
        });

    }

    private getRandomHexString() {
        const randomBytes = crypto.randomBytes(4); // 4 bytes = 32 bits
        const randomNumber = randomBytes.readUInt32BE(0); // Convert bytes to a 32-bit unsigned integer
        const hexString = randomNumber.toString(16).padStart(8, '0'); // Convert to hex and pad with zeros
        return hexString;
    }


    private async handleMessage(message: string) {
        console.log('Received:', message);

        // Parse the message and check if it's the initial subscription message
        let parsedMessage = null;
        try {
            parsedMessage = JSON.parse(message);
        } catch (e) {
            console.log(e);
            this.promiseSocket.end();
        }

        switch (parsedMessage.method) {
            case eRequestMethod.SUBSCRIBE: {
                const subscriptionMessage = plainToInstance(
                    SubscriptionMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    forbidNonWhitelisted: true,
                };

                const errors = await validate(subscriptionMessage, validatorOptions);

                if (errors.length === 0) {
                    this.clientSubscription = subscriptionMessage;

                    await this.promiseSocket.write(JSON.stringify(this.clientSubscription.response(this.extraNonce)) + '\n');
                } else {
                    const err = new StratumErrorMessage(
                        subscriptionMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Subscription error',
                        errors).response();
                    console.error(err);
                    await this.promiseSocket.write(err);
                }

                break;
            }
            case eRequestMethod.CONFIGURE: {

                const configurationMessage = plainToInstance(
                    ConfigurationMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    forbidNonWhitelisted: true,
                };

                const errors = await validate(configurationMessage, validatorOptions);

                if (errors.length === 0) {
                    this.clientConfiguration = configurationMessage;
                    //const response = this.buildSubscriptionResponse(configurationMessage.id);
                    await this.promiseSocket.write(JSON.stringify(this.clientConfiguration.response()) + '\n');
                } else {
                    const err = new StratumErrorMessage(
                        configurationMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Configuration error',
                        errors).response();
                    console.error(err);
                    await this.promiseSocket.write(err);
                }

                break;
            }
            case eRequestMethod.AUTHORIZE: {
                const authorizationMessage = plainToInstance(
                    AuthorizationMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    forbidNonWhitelisted: true,
                };

                const errors = await validate(authorizationMessage, validatorOptions);

                if (errors.length === 0) {
                    this.clientAuthorization = authorizationMessage;

                    //const response = this.buildSubscriptionResponse(authorizationMessage.id);
                    await this.promiseSocket.write(JSON.stringify(this.clientAuthorization.response()) + '\n');
                } else {
                    const err = new StratumErrorMessage(
                        authorizationMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Authorization error',
                        errors).response();
                    console.error(err);
                    await this.promiseSocket.write(err);
                }

                break;
            }
            case eRequestMethod.SUGGEST_DIFFICULTY: {
                if (this.usedSuggestedDifficulty == true) {
                    return;
                }

                const suggestDifficultyMessage = plainToInstance(
                    SuggestDifficulty,
                    parsedMessage
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    forbidNonWhitelisted: true,
                };

                const errors = await validate(suggestDifficultyMessage, validatorOptions);

                if (errors.length === 0) {

                    this.clientSuggestedDifficulty = suggestDifficultyMessage;
                    this.sessionDifficulty = suggestDifficultyMessage.suggestedDifficulty;
                    await this.promiseSocket.write(JSON.stringify(this.clientSuggestedDifficulty.response(this.sessionDifficulty)) + '\n');
                    this.usedSuggestedDifficulty = true;
                } else {
                    const err = new StratumErrorMessage(
                        suggestDifficultyMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Suggest difficulty error',
                        errors).response();
                    console.error(err);
                    await this.promiseSocket.write(err);
                }
                break;
            }
            case eRequestMethod.SUBMIT: {
                const miningSubmitMessage = plainToInstance(
                    MiningSubmitMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    forbidNonWhitelisted: true,
                };

                const errors = await validate(miningSubmitMessage, validatorOptions);

                if (errors.length === 0) {
                    await this.handleMiningSubmission(miningSubmitMessage);
                    await this.promiseSocket.write(JSON.stringify(miningSubmitMessage.response()) + '\n');


                } else {
                    const err = new StratumErrorMessage(
                        miningSubmitMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Suggest difficulty error',
                        errors).response();
                    console.error(err);
                    await this.promiseSocket.write(err);
                }
                break;
            }
        }


        if (this.clientSubscription != null
            && this.clientConfiguration != null
            && this.clientAuthorization != null
            && this.stratumInitialized == false) {

            if (this.clientSuggestedDifficulty == null) {
                console.log(`Setting difficulty to ${this.sessionDifficulty}`)
                const setDifficulty = JSON.stringify(new SuggestDifficulty().response(this.sessionDifficulty));
                await this.promiseSocket.write(setDifficulty + '\n');
            }

            this.stratumInitialized = true;

            this.entity = await this.clientService.save({
                sessionId: this.extraNonce,
                address: this.clientAuthorization.address,
                clientName: this.clientAuthorization.worker,
                startTime: new Date(),
            });

            let lastIntervalCount = undefined;
            let skipNext = false;
            combineLatest([this.blockTemplateService.currentBlockTemplate$, interval(60000).pipe(startWith(-1))])
                .pipe(takeUntil(this.easyUnsubscribe))
                .subscribe(async ([{ blockTemplate }, interValCount]) => {
                    let clearJobs = false;
                    if (lastIntervalCount === interValCount) {
                        clearJobs = true;
                        skipNext = true;
                        console.log('new block')
                    }

                    if (skipNext == true && clearJobs == false) {
                        skipNext = false;
                        return;
                    }

                    lastIntervalCount = interValCount;

                    await this.sendNewMiningJob(blockTemplate, clearJobs);

                    await this.checkDifficulty();


                });

        }
    }

    private async sendNewMiningJob(blockTemplate: IBlockTemplate, clearJobs: boolean) {

        // const payoutInformation = [
        //     { address: 'bc1q99n3pu025yyu0jlywpmwzalyhm36tg5u37w20d', percent: 1.8 },
        //     { address: this.clientAuthorization.address, percent: 98.2 }
        // ];

        const payoutInformation = [
            { address: this.clientAuthorization.address, percent: 100 }
        ];

        const job = new MiningJob(this.stratumV1JobsService.getNextId(), payoutInformation, blockTemplate, clearJobs);

        this.stratumV1JobsService.addJob(job, clearJobs);
        ;

        await this.promiseSocket.write(job.response());

        console.log(`Sent new job to ${this.extraNonce}. (clearJobs: ${clearJobs})`)

    }


    private async handleMiningSubmission(submission: MiningSubmitMessage) {

        const job = this.stratumV1JobsService.getJobById(submission.jobId);
        // a miner may submit a job that doesn't exist anymore if it was removed by a new block notification
        if (job == null) {
            const err = new StratumErrorMessage(
                submission.id,
                eStratumErrorCode.JobNotFound,
                'Job not found').response();
            console.error(err);
            await this.promiseSocket.write(err);
            return;
        }
        const updatedJobBlock = job.copyAndUpdateBlock(
            parseInt(submission.versionMask, 16),
            parseInt(submission.nonce, 16),
            this.extraNonce,
            submission.extraNonce2,
            parseInt(submission.ntime, 16)
        );
        const { submissionDifficulty, submissionHash } = this.calculateDifficulty(updatedJobBlock.toBuffer(true));

        console.log(`DIFF: ${Math.round(submissionDifficulty)} of ${this.sessionDifficulty} from ${this.clientAuthorization.worker + '.' + this.extraNonce}`);

        if (submissionDifficulty >= this.sessionDifficulty) {

            if (submissionDifficulty >= (job.networkDifficulty / 2)) {
                console.log('!!! BLOCK FOUND !!!');
                const blockHex = updatedJobBlock.toHex(false);
                this.bitcoinRpcService.SUBMIT_BLOCK(blockHex);
            }
            try {
                await this.statistics.addSubmission(this.entity, submissionHash, this.sessionDifficulty);
            } catch (e) {
                const err = new StratumErrorMessage(
                    submission.id,
                    eStratumErrorCode.DuplicateShare,
                    'Duplicate share').response();
                console.error(err);
                await this.promiseSocket.write(err);

                if (submissionDifficulty > this.entity.bestDifficulty) {
                    await this.clientService.updateBestDifficulty(this.extraNonce, submissionDifficulty);
                    this.entity.bestDifficulty = submissionDifficulty;
                }
            }

        } else {
            const err = new StratumErrorMessage(
                submission.id,
                eStratumErrorCode.LowDifficultyShare,
                'Difficulty too low').response();
            console.error(err);
            await this.promiseSocket.write(err);

        }

        await this.checkDifficulty();

    }

    private async checkDifficulty() {
        const targetDiff = this.statistics.getSuggestedDifficulty(this.sessionDifficulty);
        if (targetDiff == null) {
            return;
        }

        if (targetDiff != this.sessionDifficulty) {
            console.log(`Adjusting difficulty from ${this.sessionDifficulty} to ${targetDiff}`);
            this.sessionDifficulty = targetDiff;

            const data = JSON.stringify({
                id: null,
                method: eResponseMethod.SET_DIFFICULTY,
                params: [targetDiff]
            }) + '\n';

            await this.promiseSocket.write(data);

            // we need to clear the jobs so that the difficulty set takes effect. Otherwise the different miner implementations can cause issues
            const { blockTemplate } = await firstValueFrom(this.blockTemplateService.currentBlockTemplate$);
            await this.sendNewMiningJob(blockTemplate, true);

        }
    }

    public calculateDifficulty(header: Buffer): { submissionDifficulty: number, submissionHash: string } {

        const hashBuffer: Buffer = crypto.createHash('sha256').update(header).digest();
        const hashResult: Buffer = crypto.createHash('sha256').update(hashBuffer).digest();

        let s64 = this.le256todouble(hashResult);

        const truediffone = Big('26959535291011309493156476344723991336010898738574164086137773096960');
        const difficulty = truediffone.div(s64.toString()).toNumber();
        return { submissionDifficulty: difficulty, submissionHash: hashResult.toString('hex') };
    }


    private le256todouble(target: Buffer): bigint {

        const number = target.reduceRight((acc, byte) => {
            // Shift the number 8 bits to the left and OR with the current byte
            return (acc << BigInt(8)) | BigInt(byte);
        }, BigInt(0));

        return number;
    }

}