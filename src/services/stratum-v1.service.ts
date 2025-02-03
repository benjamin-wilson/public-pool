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

      if (process.env.MASTER == 'true') {
        await this.clientService.deleteAll();
      }
      setTimeout(() => {
        process.env.STRATUM_PORTS.split(',').forEach(port =>{
          this.startSocketServer(parseInt(port));
        });
      }, 1000 * 10)

  }

  private startSocketServer(port: number) {
    const server = new Server(async (socket: Socket) => {
        // Set 5-minute timeout
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

        // Unified cleanup function
        const cleanup = async (reason: string) => {
            if (client.extraNonceAndSessionId != null) {
                await client.destroy();
                console.log(`Client ${client.extraNonceAndSessionId} disconnected, Reason: ${reason}`);
            }
            if (!socket.destroyed) {
                socket.end();
                socket.destroy();
            }
        };

        // Handle client disconnection
        socket.on('close', async (hadError: boolean) => {
            await cleanup(hadError ? "Error" : "Normal Closure");
        });

        // Handle socket timeouts
        socket.on('timeout', async () => {
            console.log(`Socket timeout ${socket.remoteAddress}, ${socket.bytesRead}/${socket.bytesWritten}, ${client.clientSubscription?.userAgent}`);
            await cleanup("Timeout");
        });

        // Handle errors properly
        socket.on('error', async (error: Error) => {
            console.log(`Socket error: ${error.message}`);
            await cleanup("Error");
        });

    });

    // Ensure server itself handles errors
    server.on('error', (err) => {
        console.error(`Server error: ${err.message}`);
    });

    server.listen(port, () => {
        console.log(`Stratum server is listening on port ${port}`);
    });
}


}