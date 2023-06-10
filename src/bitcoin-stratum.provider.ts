import { Injectable, OnModuleInit } from '@nestjs/common';
import { Server, Socket } from 'net';
import { BehaviorSubject, take } from 'rxjs';

import { BitcoinRpcService } from './bitcoin-rpc.service';
import { IBlockTempalte } from './models/IBlockTempalte';
import { MiningJob } from './models/MiningJob';
import { StratumV1Client } from './models/StratumV1Client';

@Injectable()
export class BitcoinStratumProvider implements OnModuleInit {

  public clients: StratumV1Client[] = [];

  private server: Server;

  private blockTemplate: IBlockTempalte;

  private interval: NodeJS.Timer;

  private newMiningJobEmitter: BehaviorSubject<string> = new BehaviorSubject(null);

  private latestJob: MiningJob;


  constructor(private readonly bitcoinRpcService: BitcoinRpcService) {

    this.server = new Server((socket: Socket) => {
      console.log('New client connected:', socket.remoteAddress);

      const client = new StratumV1Client(socket, this.newMiningJobEmitter.asObservable());

      client.onInitialized.pipe(take(1)).subscribe(() => {
        if (this.latestJob == null) {
          return;
        }
        const job = this.latestJob.response();
        const jobString = JSON.stringify(job);
        client.localMiningJobEmitter.next(jobString);
      });

      // this.clients.push(client);

      // console.log('Number of Clients:', this.clients.length);


    });

  }


  async onModuleInit(): Promise<void> {
    console.log('onModuleInit');
    this.blockTemplate = await this.bitcoinRpcService.getBlockTemplate();

    clearInterval(this.interval);
    const job = new MiningJob(this.blockTemplate).response();
    this.newMiningJobEmitter.next(JSON.stringify(job));

    this.interval = setInterval(() => {
      this.latestJob = new MiningJob(this.blockTemplate);

      const job = this.latestJob.response();
      const jobString = JSON.stringify(job);

      this.newMiningJobEmitter.next(jobString);
    }, 60000);

    return;
  }


  listen(port: number) {
    this.server.listen(port, () => {
      console.log(`Bitcoin Stratum server is listening on port ${port}`);
    });
  }
}