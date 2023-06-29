import Big from 'big.js';
import { plainToInstance } from 'class-transformer';
import { validate, ValidatorOptions } from 'class-validator';
import * as crypto from 'crypto';
import { Socket } from 'net';
import { combineLatest, firstValueFrom, interval, startWith } from 'rxjs';

import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { BlockTemplateService } from '../services/block-template.service';
import { StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { EasyUnsubscribe } from '../utils/AutoUnsubscribe';
import { IBlockTemplate } from './bitcoin-rpc/IBlockTemplate';
import { eRequestMethod } from './enums/eRequestMethod';
import { eResponseMethod } from './enums/eResponseMethod';
import { MiningJob } from './MiningJob';
import { AuthorizationMessage } from './stratum-messages/AuthorizationMessage';
import { ConfigurationMessage } from './stratum-messages/ConfigurationMessage';
import { MiningSubmitMessage } from './stratum-messages/MiningSubmitMessage';
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
    private sessionDifficulty: number = 524288;
    private entity: ClientEntity;

    public extraNonce: string;

    constructor(
        public readonly socket: Socket,
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

        this.socket.on('data', this.handleData.bind(this, this.socket));

    }

    private getRandomHexString() {
        const randomBytes = crypto.randomBytes(4); // 4 bytes = 32 bits
        const randomNumber = randomBytes.readUInt32BE(0); // Convert bytes to a 32-bit unsigned integer
        const hexString = randomNumber.toString(16).padStart(8, '0'); // Convert to hex and pad with zeros
        return hexString;
    }

    private async handleData(socket: Socket, data: Buffer) {
        const message = data.toString();

        message.split('\n')
            .filter(m => m.length > 0)
            .forEach(this.handleMessage.bind(this, socket));

    }


    private async handleMessage(socket: Socket, message: string) {
        console.log('Received:', message);

        // Parse the message and check if it's the initial subscription message
        let parsedMessage = null;
        try {
            parsedMessage = JSON.parse(message);
        } catch (e) {
            console.log(e);
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

                    socket.write(JSON.stringify(this.clientSubscription.response(this.extraNonce)) + '\n');
                } else {
                    console.error(errors);
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
                    socket.write(JSON.stringify(this.clientConfiguration.response()) + '\n');
                } else {
                    console.error(errors);
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
                    socket.write(JSON.stringify(this.clientAuthorization.response()) + '\n');
                } else {
                    console.error(errors);
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
                    socket.write(JSON.stringify(this.clientSuggestedDifficulty.response(this.sessionDifficulty)) + '\n');
                    this.usedSuggestedDifficulty = true;
                } else {
                    console.error(errors);
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
                    socket.write(JSON.stringify(miningSubmitMessage.response()) + '\n');


                } else {
                    console.error(errors);
                }
                break;
            }
        }


        if (this.clientSubscription != null
            && this.clientConfiguration != null
            && this.clientAuthorization != null
            && this.clientSuggestedDifficulty != null
            && this.stratumInitialized == false) {

            this.stratumInitialized = true;

            this.entity = await this.clientService.save({
                sessionId: this.extraNonce,
                address: this.clientAuthorization.address,
                clientName: this.clientAuthorization.worker,
                startTime: new Date(),
            });

            let lastIntervalCount = undefined;
            let skipNext = false;
            combineLatest([this.blockTemplateService.currentBlockTemplate$, interval(60000).pipe(startWith(-1))]).subscribe(async ([{ blockTemplate }, interValCount]) => {
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

                this.sendNewMiningJob(blockTemplate, clearJobs);

                await this.checkDifficulty();


            });

        }
    }

    private sendNewMiningJob(blockTemplate: IBlockTemplate, clearJobs: boolean) {

        // const payoutInformation = [
        //     { address: 'bc1q99n3pu025yyu0jlywpmwzalyhm36tg5u37w20d', percent: 1.8 },
        //     { address: this.clientAuthorization.address, percent: 98.2 }
        // ];

        const payoutInformation = [
            { address: this.clientAuthorization.address, percent: 100 }
        ];

        const job = new MiningJob(this.stratumV1JobsService.getNextId(), payoutInformation, blockTemplate, clearJobs);

        this.stratumV1JobsService.addJob(job, clearJobs);

        const data = job.response + '\n';

        this.socket.write(data);

        console.log(`Sent new job to ${this.extraNonce}. (clearJobs: ${clearJobs})`)

    }


    private async handleMiningSubmission(submission: MiningSubmitMessage) {

        const job = this.stratumV1JobsService.getJobById(submission.jobId);
        // a miner may submit a job that doesn't exist anymore if it was removed by a new block notification 
        if (job == null) {
            console.log('job not found')
            return;
        }
        const updatedJobBlock = job.copyAndUpdateBlock(
            parseInt(submission.versionMask, 16),
            parseInt(submission.nonce, 16),
            this.extraNonce,
            submission.extraNonce2
        );
        const submissionDifficulty = this.calculateDifficulty(updatedJobBlock.toBuffer(true));

        console.log(`DIFF: ${Math.round(submissionDifficulty)} of ${this.sessionDifficulty} from ${this.clientAuthorization.worker + '.' + this.extraNonce}`);

        if (submissionDifficulty >= this.sessionDifficulty) {

            if (submissionDifficulty >= (job.networkDifficulty / 2)) {
                console.log('!!! BOCK FOUND !!!');
                const blockHex = updatedJobBlock.toHex(false);
                this.bitcoinRpcService.SUBMIT_BLOCK(blockHex);
            }

            await this.statistics.addSubmission(this.entity, this.sessionDifficulty);
            if (submissionDifficulty > this.entity.bestDifficulty) {
                await this.clientService.updateBestDifficulty(this.extraNonce, submissionDifficulty);
                this.entity.bestDifficulty = submissionDifficulty;
            }

        } else {
            console.log(`Difficulty too low`);
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

            this.socket.write(data);

            // we need to clear the jobs so that the difficulty set takes effect. Otherwise the different miner implementations can cause issues
            const { blockTemplate } = await firstValueFrom(this.blockTemplateService.currentBlockTemplate$);
            this.sendNewMiningJob(blockTemplate, true);




        }
    }

    public calculateDifficulty(header: Buffer): number {

        const hashBuffer: Buffer = crypto.createHash('sha256').update(header).digest();
        const hashResult: Buffer = crypto.createHash('sha256').update(hashBuffer).digest();

        let s64 = this.le256todouble(hashResult);

        const truediffone = Big('26959535291011309493156476344723991336010898738574164086137773096960');
        return truediffone.div(s64.toString()).toNumber();
    }


    private le256todouble(target: Buffer): bigint {

        const number = target.reduceRight((acc, byte) => {
            // Shift the number 8 bits to the left and OR with the current byte
            return (acc << BigInt(8)) | BigInt(byte);
        }, BigInt(0));

        return number;
    }

}