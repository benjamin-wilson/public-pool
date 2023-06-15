import { MiningJob } from '../MiningJob';
import { MiningSubmitMessage } from './MiningSubmitMessage';

describe('MiningSubmitMessage', () => {


    beforeEach(async () => {



    });

    describe('root', () => {

        const value = new MiningSubmitMessage().testNonceValue({
            version: 0x20000004,
            prevhash: "0c859545a3498373a57452fac22eb7113df2a465000543520000000000000000",
            merkleRoot: "5bdc1968499c3393873edf8e07a1c3a50a97fc3a9d1a376bbf77087dd63778eb",
            ntime: 0x647025b5,
            target: 0x1705ae3a,
        } as MiningJob, 0x0a029ed1);

        it('should be correct difficulty', () => {
            expect(value).toEqual(683);
        });
    });
});
