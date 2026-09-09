import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { BitcoinRpcService } from './bitcoin-rpc.service';

describe('BitcoinRpcService', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    it('should configure axios with keepAlive agents on module init', async () => {
        const axiosCreateSpy = jest.spyOn(axios, 'create').mockReturnValue({
            post: jest.fn().mockResolvedValue({ data: { result: {} } })
        } as any);

        const configService = {
            get: jest.fn((key: string) => {
                switch (key) {
                    case 'BITCOIN_RPC_URL': return 'http://127.0.0.1';
                    case 'BITCOIN_RPC_USER': return 'user';
                    case 'BITCOIN_RPC_PASSWORD': return 'pass';
                    case 'BITCOIN_RPC_PORT': return '8332';
                    case 'BITCOIN_RPC_TIMEOUT': return '10000';
                    default: return null;
                }
            })
        } as unknown as ConfigService;

        const service = new BitcoinRpcService(configService, null as any);
        await service.onModuleInit();

        expect(axiosCreateSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                httpAgent: expect.objectContaining({ keepAlive: true }),
                httpsAgent: expect.objectContaining({ keepAlive: true })
            })
        );
        axiosCreateSpy.mockRestore();
    });
});
