import { Injectable, OnModuleInit } from '@nestjs/common';
import { Server, Socket } from 'net';

import { BitcoinRpcService } from './bitcoin-rpc.service';
import { MiningJob } from './models/MiningJob';
import { StratumV1Client } from './models/StratumV1Client';
import { StratumV1JobsService } from './stratum-v1-jobs.service';


@Injectable()
export class StratumV1Service implements OnModuleInit {

  private miningNotifyInterval: NodeJS.Timer;


  public clients: StratumV1Client[] = [];



  constructor(
    private readonly bitcoinRpcService: BitcoinRpcService,
    private readonly stratumV1JobsService: StratumV1JobsService
  ) {
  }


  async onModuleInit(): Promise<void> {

    this.startSocketServer();

    this.listenForNewBlocks();

  }

  private startSocketServer() {
    new Server((socket: Socket) => {

      console.log('New client connected:', socket.remoteAddress);

      const client = new StratumV1Client(socket, this.stratumV1JobsService);
      this.clients.push(client);


      socket.on('end', () => {
        // Handle socket disconnection
        console.log('Client disconnected:', socket.remoteAddress);
        this.clients = this.clients.filter(c => c.id == client.id);
      });

      socket.on('error', (error: Error) => {
        // Handle socket error
        console.error('Socket error:', error);
        this.clients = this.clients.filter(c => c.id == client.id);
      });

    }).listen(3333, () => {
      console.log(`Bitcoin Stratum server is listening on port ${3333}`);
    });

  }

  private listenForNewBlocks() {
    this.bitcoinRpcService.newBlock().subscribe(async () => {
      console.log('NEW BLOCK')
      this.resetMiningNotifyInterval();

      const blockTemplate = await this.bitcoinRpcService.getBlockTemplate();
      const job = new MiningJob(this.stratumV1JobsService.getNextId(), blockTemplate, true);
      this.stratumV1JobsService.addJob(job, true);


      this.clients
        .filter(client => client.stratumInitialized)
        .forEach(client => {
          client.newBlock(job);
        });

    });
  }




  private resetMiningNotifyInterval() {
    clearInterval(this.miningNotifyInterval);
    this.miningNotifyInterval = setInterval(async () => {

      const blockTemplate = await this.bitcoinRpcService.getBlockTemplate();
      const job = new MiningJob(this.stratumV1JobsService.getNextId(), blockTemplate, false);
      this.stratumV1JobsService.addJob(job, false);

    }, 60000);
  }

}