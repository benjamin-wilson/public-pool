import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'net';

import { StratumV1Client } from '../models/StratumV1Client';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { NotificationService } from './notification.service';
import { StratumV1JobsService } from './stratum-v1-jobs.service';


@Injectable()
export class StratumV1Service implements OnModuleInit {

  constructor(
    private readonly bitcoinRpcService: BitcoinRpcService,
    private readonly clientService: ClientService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly notificationService: NotificationService,
    private readonly blocksService: BlocksService,
    private readonly configService: ConfigService,
    private readonly stratumV1JobsService: StratumV1JobsService,
    private readonly addressSettingsService: AddressSettingsService
  ) {

  }


  async onModuleInit(): Promise<void> {

    //await this.clientStatisticsService.deleteAll();

    await this.clientService.deleteAll();


    this.startSocketServer();
  }

  private startSocketServer() {
    const server = new Server(async (socket: Socket) => {

      socket.setTimeout(5000, () => {
        console.log(`Client ${client.extraNonceAndSessionId} timeout`);
        socket.destroy();
      });

      const client = new StratumV1Client(
        socket,
        this.stratumV1JobsService,
        this.bitcoinRpcService,
        this.clientService,
        this.clientStatisticsService,
        this.notificationService,
        this.blocksService,
        this.configService,
        this.addressSettingsService
      );


      socket.on('close', async (hadError: boolean) => {
        if (client.extraNonceAndSessionId != null) {
          // Handle socket disconnection
          await client.destroy();
          console.log(`Client ${client.extraNonceAndSessionId} disconnected, hadError?:${hadError}`);
        }
      });

      socket.on('error', async (error: Error) => { });

      //   //console.log(`Client disconnected, socket error,  ${client.extraNonceAndSessionId}`);


    });

    server.listen(3333, () => {
      console.log(`Bitcoin Stratum server is listening on port ${3333}`);
    });

  }

}