import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'net';
import { PromiseSocket } from 'promise-socket';

import { StratumV1Client } from '../models/StratumV1Client';
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
    private readonly stratumV1JobsService: StratumV1JobsService
  ) {

  }


  async onModuleInit(): Promise<void> {

    //await this.clientStatisticsService.deleteAll();
    await this.clientService.deleteAll();

    this.startSocketServer();
  }

  private startSocketServer() {
    new Server(async (s: Socket) => {

      const promiseSocket = new PromiseSocket(s);

      const client = new StratumV1Client(
        promiseSocket,
        this.stratumV1JobsService,
        this.bitcoinRpcService,
        this.clientService,
        this.clientStatisticsService,
        this.notificationService,
        this.blocksService,
        this.configService
      );



      const clientCount = await this.clientService.connectedClientCount();

      console.log(`New client connected: ${promiseSocket.socket.remoteAddress}, ${clientCount} total clients`);

      promiseSocket.socket.on('end', async (error: Error) => {
        // Handle socket disconnection
        client.destroy();
        promiseSocket.destroy();
        await this.clientService.delete(client.extraNonceAndSessionId);

        const clientCount = await this.clientService.connectedClientCount();

        console.log(`Client disconnected: ${promiseSocket.socket.remoteAddress},  ${client.extraNonceAndSessionId},  ${clientCount} total clients`);
      });

      promiseSocket.socket.on('error', async (error: Error) => {

        client.destroy();
        promiseSocket.destroy();
        await this.clientService.delete(client.extraNonceAndSessionId);

        const clientCount = await this.clientService.connectedClientCount();
        console.log(`Socket error:`, error);
        console.log(`Client disconnected: ${promiseSocket.socket.remoteAddress},  ${client.extraNonceAndSessionId}, ${clientCount} total clients`);

      });

    }).listen(3333, () => {
      console.log(`Bitcoin Stratum server is listening on port ${3333}`);
    });

  }

}