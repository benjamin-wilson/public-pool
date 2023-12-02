import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
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

  private maxConnections = 100;
  private currentConnections = 0;

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

  @Interval(1000 * 30)
  public async incrementConnections() {
    this.maxConnections += 100;
  }

  async onModuleInit(): Promise<void> {
    console.log(`Enable Solo: ${process.env.ENABLE_SOLO}`)
    if (process.env.ENABLE_SOLO == 'true') {
      //await this.clientStatisticsService.deleteAll();
      console.log(`NODE_APP_INSTANCE: ${process.env.NODE_APP_INSTANCE}`)
      if (process.env.NODE_APP_INSTANCE == '0') {
        await this.clientService.deleteAll();
      }

      setTimeout(() => {
        this.startSocketServer();
      }, 1000 * 10)

    }
  }

  private startSocketServer() {
    const server = new Server(async (socket: Socket) => {

      this.currentConnections++;

      if (this.currentConnections > this.maxConnections) {
        // If the maximum number of connections is reached, reject the new connection
        console.log('Connection limit reached. Rejecting new connection.');
        socket.end(); // Close the socket immediately
        this.currentConnections--; // Decrement the count as the connection is rejected
      }

      //5 min
      socket.setTimeout(1000 * 60 * 5);

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

      socket.on('timeout', () => {
        console.log('socket timeout');
        socket.end();
        socket.destroy();
      });


      socket.on('end', () => {
        this.currentConnections--;
      });

      socket.on('error', async (error: Error) => { });

      //   //console.log(`Client disconnected, socket error,  ${client.extraNonceAndSessionId}`);


    });


    server.listen(process.env.STRATUM_PORT, () => {
      console.log(`Stratum server is listening on port ${process.env.STRATUM_PORT}`);
    });

  }

}