import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import * as bitcoinjs from 'bitcoinjs-lib';
import { useContainer } from 'class-validator';
import { readFileSync, watch } from 'fs';
import * as path from 'path';
import * as ecc from 'tiny-secp256k1';

import { AppModule } from './app.module';

const DEFAULT_API_MAX_CONNECTIONS = 512;
const DEFAULT_API_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_API_HEADERS_TIMEOUT_MS = 10000;
const DEFAULT_API_KEEP_ALIVE_TIMEOUT_MS = 5000;
const DEFAULT_API_SOCKET_TIMEOUT_MS = 15000;
const DEFAULT_API_TLS_HANDSHAKE_TIMEOUT_MS = 3000;
const DEFAULT_API_LISTEN_BACKLOG = 1024;

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

  let options: any = {};
  if (secure) {
    options = {
      https: {
        key: readFileSync(keyPath),
        cert: readFileSync(certPath),
        handshakeTimeout: getPositiveIntegerEnv('API_TLS_HANDSHAKE_TIMEOUT_MS', DEFAULT_API_TLS_HANDSHAKE_TIMEOUT_MS),
      }
    };
  }

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(options));
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
  useContainer(app.select(AppModule), { fallbackOnErrors: true });

  // Taproot
  bitcoinjs.initEccLib(ecc);

  if (!serveApi) {
    await app.init();
    console.log('Worker process skipping API listener');
    return;
  }

  configureApiServer(app.getHttpServer());

  try {
    const address = await app.listen({
      port: parseInt(process.env.API_PORT, 10),
      host: '0.0.0.0',
      backlog: getPositiveIntegerEnv('API_LISTEN_BACKLOG', DEFAULT_API_LISTEN_BACKLOG),
    });
    console.log(`API listening on ${address}`);
  } catch (error) {
    console.error('API listen failed:', error);
    await app.close().catch(() => undefined);
    process.exit(1);
  }

  // --- Live-reload TLS certs/keys when they change on disk ---
  if (secure) {
    // Fastify's underlying Node https server
    const server: any = app.getHttpServer();

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

function configureApiServer(server: any) {
  const socketTimeoutMs = getPositiveIntegerEnv('API_SOCKET_TIMEOUT_MS', DEFAULT_API_SOCKET_TIMEOUT_MS);

  server.maxConnections = getPositiveIntegerEnv('API_MAX_CONNECTIONS', DEFAULT_API_MAX_CONNECTIONS);
  server.requestTimeout = getPositiveIntegerEnv('API_REQUEST_TIMEOUT_MS', DEFAULT_API_REQUEST_TIMEOUT_MS);
  server.headersTimeout = getPositiveIntegerEnv('API_HEADERS_TIMEOUT_MS', DEFAULT_API_HEADERS_TIMEOUT_MS);
  server.keepAliveTimeout = getPositiveIntegerEnv('API_KEEP_ALIVE_TIMEOUT_MS', DEFAULT_API_KEEP_ALIVE_TIMEOUT_MS);
  server.timeout = socketTimeoutMs;

  server.on('connection', (socket: NodeJS.ReadWriteStream & { setTimeout?: (ms: number) => void; destroy?: () => void }) => {
    socket.setTimeout?.(socketTimeoutMs);
    socket.once?.('timeout', () => {
      socket.destroy?.();
    });
  });
}

function getPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

bootstrap();
