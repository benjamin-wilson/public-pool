import { Injectable } from '@nestjs/common';
import { Server, Socket } from 'net';

import { StratumV1Client } from './models/StratumV1Client';

@Injectable()
export class BitcoinStratumProvider {

  public clients: StratumV1Client[] = [];

  private server: Server;

  constructor() {
    this.server = new Server((socket: Socket) => {
      console.log('New client connected:', socket.remoteAddress);

      const client = new StratumV1Client(socket);
      this.clients.push(client);

      console.log('Number of Clients:', this.clients.length);


    });
  }







  listen(port: number) {
    this.server.listen(port, () => {
      console.log(`Bitcoin Stratum server is listening on port ${port}`);
    });
  }
}