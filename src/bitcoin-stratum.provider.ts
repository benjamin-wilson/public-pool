import { Injectable, OnModuleInit } from '@nestjs/common';
import { Server, Socket } from 'net';
import { BehaviorSubject, skip, take } from 'rxjs';

import { BitcoinRpcService } from './bitcoin-rpc.service';
import { IBlockTemplate } from './models/bitcoin-rpc/IBlockTemplate';
import { MiningJob } from './models/MiningJob';
import { StratumV1Client } from './models/StratumV1Client';

@Injectable()
export class BitcoinStratumProvider implements OnModuleInit {

  public clients: StratumV1Client[] = [];

  private server: Server;

  private blockTemplate: IBlockTemplate;

  private interval: NodeJS.Timer;

  private newMiningJobEmitter: BehaviorSubject<string> = new BehaviorSubject(null);

  private latestJob: MiningJob;


  constructor(private readonly bitcoinRpcService: BitcoinRpcService) {



  }


  async onModuleInit(): Promise<void> {
    console.log('onModuleInit');

    this.blockTemplate = await this.bitcoinRpcService.getBlockTemplate();
    this.latestJob = new MiningJob(this.blockTemplate)


    this.server = new Server((socket: Socket) => {
      console.log('New client connected:', socket.remoteAddress);

      const client = new StratumV1Client(socket, this.newMiningJobEmitter.asObservable());

      client.onInitialized.pipe(skip(1), take(1)).subscribe(() => {
        console.log('Client Ready')
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

    this.server.listen(3333, () => {
      console.log(`Bitcoin Stratum server is listening on port ${3333}`);
    });



    //clearInterval(this.interval);

    this.newMiningJobEmitter.next(JSON.stringify(this.latestJob.response()));

    this.interval = setInterval(async () => {
      this.blockTemplate = await this.bitcoinRpcService.getBlockTemplate();

      this.latestJob = new MiningJob(this.blockTemplate)
      this.newMiningJobEmitter.next(JSON.stringify(this.latestJob.response()));
    }, 60000);

    return;
  }


}