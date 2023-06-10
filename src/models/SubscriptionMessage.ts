import { eMethod } from './enums/eMethod';

export class SubscriptionMessage {
    id: number;
    method: eMethod.SUBSCRIBE;
    params: string[];
}