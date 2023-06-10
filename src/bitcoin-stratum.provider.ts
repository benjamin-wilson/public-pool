import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, ValidatorOptions } from 'class-validator';
import { Server, Socket } from 'net';

import { eMethod } from './models/enums/eMethod';
import { SubscriptionMessage } from './models/SubscriptionMessage';

@Injectable()
export class BitcoinStratumProvider {
  private server: Server;

  constructor() {
    this.server = new Server((socket: Socket) => {
      console.log('New client connected:', socket.remoteAddress);

      socket.on('data', this.handleData.bind(this, socket));

      socket.on('end', () => {
        // Handle socket disconnection
        console.log('Client disconnected:', socket.remoteAddress);
      });

      socket.on('error', (error: Error) => {
        // Handle socket error
        console.error('Socket error:', error);
      });
    });
  }




  private async handleData(socket: Socket, data: Buffer) {
    const message = data.toString();
    console.log('Received:', message);

    // Parse the message and check if it's the initial subscription message
    const parsedMessage = JSON.parse(message);

    if (parsedMessage.method === eMethod.SUBSCRIBE) {
      const subscriptionMessage = plainToInstance(
        SubscriptionMessage,
        parsedMessage,
      );

      const validatorOptions: ValidatorOptions = {
        whitelist: true,
        forbidNonWhitelisted: true,
      };

      const errors = await validate(subscriptionMessage, validatorOptions);

      if (errors.length === 0) {
        const response = this.buildSubscriptionResponse(subscriptionMessage.id);
        socket.write(JSON.stringify(response) + '\n');
      }
    }
  }

  private buildSubscriptionResponse(requestId: number): any {
    const subscriptionResponse = {
      id: requestId,
      result: [
        [
          [
            'mining.set_difficulty',
            '0000000c9c7a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9',
          ],
          [
            'mining.notify',
            '0000000c9c7a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9',
          ],
        ],
        'a843cfc2',
        4,
      ],
    };

    return subscriptionResponse;
  }



  listen(port: number) {
    this.server.listen(port, () => {
      console.log(`Bitcoin Stratum server is listening on port ${port}`);
    });
  }
}