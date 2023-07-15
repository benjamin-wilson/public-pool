import { ConfigService } from '@nestjs/config';
import { PromiseSocket } from 'promise-socket';

import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { BlockTemplateService } from '../services/block-template.service';
import { NotificationService } from '../services/notification.service';
import { StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { StratumV1Client } from './StratumV1Client';


describe('StratumV1Client', () => {

    let promiseSocket: PromiseSocket<any> = new PromiseSocket();
    let stratumV1JobsService: StratumV1JobsService;
    let bitcoinRpcService: BitcoinRpcService;
    let blockTemplateService: BlockTemplateService;
    let clientService: ClientService;
    let clientStatisticsService: ClientStatisticsService;
    let notificationService: NotificationService;
    let blocksService: BlocksService;
    let configService: ConfigService;

    let client: StratumV1Client;


    beforeEach(async () => {

        jest.spyOn(promiseSocket.socket, 'on').mockImplementation();

        client = new StratumV1Client(
            promiseSocket,
            stratumV1JobsService,
            blockTemplateService,
            bitcoinRpcService,
            clientService,
            clientStatisticsService,
            notificationService,
            blocksService,
            configService
        );


    });


    it('should parse message', () => {
        expect(promiseSocket.socket.on).toHaveBeenCalled();
    });


});