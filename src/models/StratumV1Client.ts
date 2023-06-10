import { plainToInstance } from 'class-transformer';
import { validate, ValidatorOptions } from 'class-validator';
import { Socket } from 'net';
import { interval } from 'rxjs';

import { eRequestMethod } from './enums/eRequestMethod';
import { eResponseMethod } from './enums/eResponseMethod';
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

    public initialized = false;

    private interval: NodeJS.Timer;



    constructor(private readonly socket: Socket) {

        this.socket.on('data', this.handleData.bind(this, this.socket));

        this.socket.on('end', () => {
            // Handle socket disconnection
            console.log('Client disconnected:', socket.remoteAddress);
        });

        this.socket.on('error', (error: Error) => {
            // Handle socket error
            console.error('Socket error:', error);
        });


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

                    socket.write(JSON.stringify(this.clientSubscription.response()) + '\n');
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
                    //this.clientSuggestedDifficulty = miningSubmitMessage;
                    socket.write(JSON.stringify(miningSubmitMessage.response()) + '\n');
                } else {
                    console.error(errors);
                }
                break;
            }
        }

        if (!this.initialized) {
            if (this.clientSubscription != null
                && this.clientConfiguration != null
                && this.clientAuthorization != null
                && this.clientSuggestedDifficulty != null) {
                this.initialized = true;

                this.manualMiningNotify();

            }

        }

    }

    private manualMiningNotify() {
        clearInterval(this.interval);
        this.miningNotify();
        this.interval = setInterval(() => {
            this.miningNotify();
        }, 60000);
    }


    private miningNotify() {
        const notification = {
            id: null,
            method: eResponseMethod.MINING_NOTIFY,
            params: [
                '64756fab0000442e',
                '39dbb5b4e173e1f9ac6f6ad92e9dde300effce6b0003ea860000000000000000',
                '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff35033e1c0c00048fef83640447483e060c',
                '0a636b706f6f6c112f736f6c6f2e636b706f6f6c2e6f72672fffffffff03e1c7872600000000160014876961d21eaba10f0701dcc78f6624a4c682270d384dc900000000001976a914f4cbe6c6bb3a8535c963169c22963d3a20e7686988ac0000000000000000266a24aa21a9ed751521cd94e7780a9a13ac8bb1da5410d30acdd2f6348876835623b04b2dc83b00000000',
                [
                    'c0c9d351b9e094dd85bc64c8909dece6226269ebfe173bb74ba2f89c51df7066',
                    '6c56f47cbfaef5688bb338bc56c4189530f12cdb98f8cc46b6a12053f1e69fdd',
                    '697cdaa8d15691f7b30dfe7f6c33957f04cfc8126fed16d2fe38c96adaa59c41',
                    'cbe8aa6e0343884a40b850df8fd3c2ffcc026acec392ce93f9e28619eb0d3dac',
                    'e023091cf0fc02684c77730a34791181a44be92f966ba579aa4cf6e98d754548',
                    '6b8fea64efe363e02ff42a4257d76a77381006eade804c8a8c9b96c9c98b1d9e',
                    '1c936bc5320cdbbe7348cdd4bf272529822e9d34dfa8e0ee0041eae635891cc3',
                    '8fed2682a3c95863c6b9440b1a47abdd3d4230181f61edf0daa2e5f0befbcf65',
                    '0837c4d162e1086ec553ea90af4be4f9747958e556598cc38cb08149e58227b1',
                    '0b5287e647c7cb6f2fcdf13d5ef3bf091d1137773d7695405d0b2768f442ee78',
                    '71eaff9247b5556fa88bca6da2e055d5db8aef2969a2d5c68f8e7efd7d39a283'
                ],
                '20000000',
                '17057e69',
                '6483ef8f',
                true
            ],

        };

        this.socket.write(JSON.stringify(notification) + '\n');
    }

}