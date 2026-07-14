import { NestFactory } from '@nestjs/core';

import { MaintenanceModule } from './maintenance.module';

async function bootstrap(): Promise<void> {
    process.env.MASTER = 'true';
    process.env.API_ENABLED = 'false';

    const application = await NestFactory.createApplicationContext(
        MaintenanceModule,
    );
    application.enableShutdownHooks();
    console.log('Maintenance services started');
}

void bootstrap();
