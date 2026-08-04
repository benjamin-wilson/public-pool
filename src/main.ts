import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import * as bitcoinjs from 'bitcoinjs-lib';
import { useContainer } from 'class-validator';
import { readFileSync, watch } from 'fs';
import * as path from 'path';
import * as ecc from 'tiny-secp256k1';

import { ApiModule } from './api.module';
import { AppModule } from './app.module';

const DEFAULT_API_CONNECTION_TIMEOUT_MS = 15_000;
const DEFAULT_API_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const DEFAULT_API_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_API_HEADERS_TIMEOUT_MS = 10_000;
const DEFAULT_API_MAX_REQUESTS_PER_SOCKET = 100;
const DEFAULT_API_MAX_CONNECTIONS_PER_WORKER = 500;

function readPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function bootstrap() {
  if (process.env.API_PORT == null) {
    console.error('It appears your environment is not configured, create and populate an .env file.');
    return;
  }

  const apiEnabled = process.env.API_ENABLED?.toLowerCase();
  const serveApi = apiEnabled == null ? process.env.MASTER !== 'false' : apiEnabled === 'true';
  const secure = serveApi && process.env.API_SECURE?.toLowerCase() === 'true';
  const currentDirectory = process.cwd();
  const keyPath = path.join(currentDirectory, 'secrets', 'key.pem');
  const certPath = path.join(currentDirectory, 'secrets', 'cert.pem');

  let options: any = serveApi
    ? {
      connectionTimeout: readPositiveInt('API_CONNECTION_TIMEOUT_MS', DEFAULT_API_CONNECTION_TIMEOUT_MS),
      keepAliveTimeout: readPositiveInt('API_KEEP_ALIVE_TIMEOUT_MS', DEFAULT_API_KEEP_ALIVE_TIMEOUT_MS),
      requestTimeout: readPositiveInt('API_REQUEST_TIMEOUT_MS', DEFAULT_API_REQUEST_TIMEOUT_MS),
      maxRequestsPerSocket: readPositiveInt('API_MAX_REQUESTS_PER_SOCKET', DEFAULT_API_MAX_REQUESTS_PER_SOCKET),
    }
    : {};
  if (secure) {
    options.https = {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    };
  }

  const appModule = process.env.API_ONLY === 'true' ? ApiModule : AppModule;
  const app = await NestFactory.create<NestFastifyApplication>(appModule, new FastifyAdapter(options));
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      //forbidNonWhitelisted: true,
      //forbidUnknownValues: true
    }),
  );

  process.on('SIGINT', () => {
    console.log(`Stopping services`);
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log(`Stopping services`);
    process.exit(0);
  });

  app.enableCors();
  useContainer(app.select(appModule), { fallbackOnErrors: true });

  // Taproot
  bitcoinjs.initEccLib(ecc);

  if (!serveApi) {
    await app.init();
    console.log('Worker process skipping API listener');
    return;
  }

  await app.listen(process.env.API_PORT, '0.0.0.0', (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`API listening on ${address}`);
  });

  const server: any = app.getHttpServer();
  server.headersTimeout = readPositiveInt('API_HEADERS_TIMEOUT_MS', DEFAULT_API_HEADERS_TIMEOUT_MS);
  server.maxConnections = readPositiveInt(
    'API_MAX_CONNECTIONS_PER_WORKER',
    DEFAULT_API_MAX_CONNECTIONS_PER_WORKER,
  );
  server.dropMaxConnection = true;

  // --- Live-reload TLS certs/keys when they change on disk ---
  if (secure) {
    // Fastify's underlying Node https server
    // Guard: only HTTPS servers expose setSecureContext
    if (typeof server?.setSecureContext === 'function') {
      let reloadTimer: NodeJS.Timeout | null = null;

      const scheduleReload = () => {
        if (reloadTimer) clearTimeout(reloadTimer);
        // Debounce multiple fs events during a single write/replace
        reloadTimer = setTimeout(() => {
          try {
            const key = readFileSync(keyPath);
            const cert = readFileSync(certPath);
            server.setSecureContext({ key, cert });
            console.log(`[TLS] Reloaded certificate @ ${new Date().toISOString()}`);
          } catch (e) {
            console.error('[TLS] Failed to reload certificate:', e);
          }
        }, 500);
      };

      // Watch both files; handle 'change' and 'rename' (rename often fired on atomic replace)
      try {
        watch(keyPath, { persistent: true }, scheduleReload);
        watch(certPath, { persistent: true }, scheduleReload);
        console.log('[TLS] Watching cert/key for changes');
      } catch (e) {
        console.error('[TLS] Failed to watch cert/key files:', e);
      }
    } else {
      console.warn('[TLS] Dynamic cert reload not available (non-HTTPS server?)');
    }
  }
}

bootstrap();
