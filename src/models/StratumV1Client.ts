import { plainToInstance } from 'class-transformer';
import { validate, ValidatorOptions } from 'class-validator';
import * as crypto from 'crypto';
import { Socket } from 'net';

import { StratumV1JobsService } from '../stratum-v1-jobs.service';
import { eRequestMethod } from './enums/eRequestMethod';
import { MiningJob } from './MiningJob';
import { AuthorizationMessage } from './stratum-messages/AuthorizationMessage';
import { ConfigurationMessage } from './stratum-messages/ConfigurationMessage';
import { MiningSubmitMessage } from './stratum-messages/MiningSubmitMessage';
import { SubscriptionMessage } from './stratum-messages/SubscriptionMessage';
import { SuggestDifficulty } from './stratum-messages/SuggestDifficultyMessage';


export class StratumV1Client {

    private clientSubscription: SubscriptionMessage;
    private clientConfiguration: ConfigurationMessage;
    private clientAuthorization: AuthorizationMessage;
    private clientSuggestedDifficulty: SuggestDifficulty;

    // public clientSubmission: BehaviorSubject<any> = new BehaviorSubject(null);

    public id: string;
    public stratumInitialized = false;

    public refreshInterval: NodeJS.Timer;

    constructor(
        public readonly socket: Socket,
        private readonly stratumV1JobsService: StratumV1JobsService
    ) {

        this.id = this.getRandomHexString();

        console.log(`id: ${this.id}`);

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

                    socket.write(JSON.stringify(this.clientSubscription.response(this.id)) + '\n');
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
                    this.clientAuthorization.parse();
                    //const response = this.buildSubscriptionResponse(authorizationMessage.id);
                    socket.write(JSON.stringify(this.clientAuthorization.response()) + '\n');
                } else {
                    console.error(errors);
                }

                break;
            }
            case eRequestMethod.SUGGEST_DIFFICULTY: {

                const suggestDifficultyMessage = plainToInstance(
                    SuggestDifficulty,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    forbidNonWhitelisted: true,
                };

                const errors = await validate(suggestDifficultyMessage, validatorOptions);

                if (errors.length === 0) {
                    this.clientSuggestedDifficulty = suggestDifficultyMessage;
                    socket.write(JSON.stringify(this.clientSuggestedDifficulty.response()) + '\n');
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
                    this.handleMiningSubmission(miningSubmitMessage);
                    //this.clientSubmission.next(miningSubmitMessage)
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

            this.newBlock(this.stratumV1JobsService.getLatestJob());

        }
    }

    public newBlock(job: MiningJob) {
        this.newJob(job);

        clearInterval(this.refreshInterval);
        this.refreshInterval = setInterval(async () => {
            this.newJob(this.stratumV1JobsService.getLatestJob());
        }, 60000);
    }

    private newJob(job: MiningJob) {
        if (this.stratumInitialized && job != null) {
            this.socket.write(job.response + '\n');
        }
    }


    private handleMiningSubmission(submission: MiningSubmitMessage) {
        submission.parse();
        const networkDifficulty = 0;
        const job = this.stratumV1JobsService.getJobById(submission.jobId);
        const diff = submission.testNonceValue(this.id, job, submission);
        console.log(`DIFF: ${diff}`);
        if (networkDifficulty < diff) {
            //this.clientSubmission.next(true);
        }
    }

}