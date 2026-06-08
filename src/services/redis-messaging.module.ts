import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { RedisMessagingService } from './redis-messaging.service';

@Global()
@Module({
    imports: [ConfigModule],
    providers: [RedisMessagingService],
    exports: [RedisMessagingService],
})
export class RedisMessagingModule { }
