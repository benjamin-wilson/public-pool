import { NestFactory } from '@nestjs/core';

import { NotifierModule } from './notifier.module';

async function bootstrap(): Promise<void> {
    process.env.MASTER = 'true';
    process.env.API_ENABLED = 'false';
    const application = await NestFactory.createApplicationContext(
        NotifierModule,
    );
    application.enableShutdownHooks();
    console.log('Authoritative block notifier started');
}

void bootstrap();
