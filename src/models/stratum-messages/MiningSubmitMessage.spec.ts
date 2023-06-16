describe('MiningSubmitMessage', () => {


    beforeEach(async () => {



    });

    // describe('test nonce', () => {

    //     const value = new MiningSubmitMessage().testNonceValue({
    //         version: 0x20000004,
    //         prevhash: "0c859545a3498373a57452fac22eb7113df2a465000543520000000000000000",
    //         merkleRoot: "5bdc1968499c3393873edf8e07a1c3a50a97fc3a9d1a376bbf77087dd63778eb",
    //         ntime: 0x647025b5,
    //         nbits: 0x1705ae3a,
    //     } as unknown as MiningJob, 167943889);

    //     it('should be correct difficulty', () => {
    //         expect(value).toEqual(683);
    //     });
    // });

    // describe('test empty version', () => {

    //     const value = new MiningSubmitMessage().testNonceValue({
    //         version: 0x20000004,
    //         prevhash: "0c859545a3498373a57452fac22eb7113df2a465000543520000000000000000",
    //         merkleRoot: "5bdc1968499c3393873edf8e07a1c3a50a97fc3a9d1a376bbf77087dd63778eb",
    //         ntime: 0x647025b5,
    //         nbits: 0x1705ae3a,
    //     } as unknown as MiningJob, 167943889, parseInt('00000000', 16));

    //     it('should be correct difficulty', () => {
    //         expect(value).toEqual(683);
    //     });
    // });

    // describe('test high value nonce', () => {

    //     const value = new MiningSubmitMessage().testNonceValue({
    //         version: 0x20a00000,
    //         prevhash: "00000000000000000002a7b66a599d17893cb312a8ee7bc15e4015ff52774f00",
    //         merkleRoot: "210bbf45c85165aab889691056cfebbfd763e11b2623a261fb6135b6bab66ce3",
    //         ntime: 1686839100,
    //         target: 52350439455487,
    //     } as MiningJob, 0x05d69c40,);

    //     it('should be correct difficulty', () => {
    //         expect(value).toEqual(683);
    //     });
    // });
});
