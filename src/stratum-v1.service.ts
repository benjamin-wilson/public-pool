import { Injectable, OnModuleInit } from '@nestjs/common';
import { Server, Socket } from 'net';

import { BitcoinRpcService } from './bitcoin-rpc.service';
import { BlockTemplateService } from './BlockTemplateService';
import { StratumV1Client } from './models/StratumV1Client';
import { ClientStatisticsService } from './ORM/client-statistics/client-statistics.service';
import { ClientService } from './ORM/client/client.service';
import { StratumV1JobsService } from './stratum-v1-jobs.service';


@Injectable()
export class StratumV1Service implements OnModuleInit {

  // public clients: StratumV1Client[] = [];

  constructor(
    private readonly bitcoinRpcService: BitcoinRpcService,
    private readonly blockTemplateService: BlockTemplateService,
    private readonly clientService: ClientService,
    private readonly clientStatisticsService: ClientStatisticsService
  ) {
  }


  async onModuleInit(): Promise<void> {

    //await this.clientStatisticsService.deleteAll();
    await this.clientService.deleteAll();

    this.startSocketServer();

  }

  private startSocketServer() {
    new Server(async (socket: Socket) => {


      const client = new StratumV1Client(socket, new StratumV1JobsService(), this.blockTemplateService, this.bitcoinRpcService, this.clientService, this.clientStatisticsService);


      const clientCount = await this.clientService.connectedClientCount();

      //this.clients.push(client);

      console.log(`New client connected: ${socket.remoteAddress}, ${clientCount} total clients`);

      socket.on('end', async () => {
        // Handle socket disconnection
        await this.clientService.delete(client.id);

        const clientCount = await this.clientService.connectedClientCount();
        console.log(`Client disconnected: ${socket.remoteAddress}, ${clientCount} total clients`);
      });

      socket.on('error', async (error: Error) => {

        await this.clientService.delete(client.id);

        const clientCount = await this.clientService.connectedClientCount();
        console.error(`Socket error:`, error);
        console.log(`Client disconnected: ${socket.remoteAddress}, ${clientCount} total clients`);

      });

    }).listen(3333, () => {
      console.log(`Bitcoin Stratum server is listening on port ${3333}`);
    });

  }



}