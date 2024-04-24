import { Injectable, OnModuleInit } from '@nestjs/common';
import { Server, Socket } from 'net';

import { ProxyClient } from '../models/ProxyClient';

@Injectable()
export class ProxyService implements OnModuleInit {
  constructor() {}

  async onModuleInit(): Promise<void> {
    if (process.env.ENABLE_PROXY == 'true') {
      console.log('Connecting to braiins');

      const proxyServer = new Server(async (socket: Socket) => {
        const proxyClient = new ProxyClient(socket);
      });

      proxyServer.listen(process.env.PROXY_PORT, () => {
        console.log(
          `Proxy server is listening on port ${process.env.PROXY_PORT}`,
        );
      });
    }
  }
}
