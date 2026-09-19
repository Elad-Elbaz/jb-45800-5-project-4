/**
 * Process entry point: connect the dependencies, open the port, and take the
 * whole thing down cleanly when Docker asks.
 */

import type { Server } from 'node:http';

import { createApp } from './app';
import { env } from './config/env';
import { DatabaseService } from './services/databaseService';
import { QueueService } from './services/queueService';
import { S3Service } from './services/s3Service';
import type { AppServices } from './services/container';
import { createLogger } from './utils/logger';

const log = createLogger('server');

/** How long a shutdown may take before the process is killed anyway. */
const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  const db = new DatabaseService(env.databaseUrl);
  const queue = new QueueService();
  const s3 = new S3Service();
  const services: AppServices = { db, queue, s3 };

  /**
   * Every dependency is connected *before* the listener opens. The alternative
   * -- listen first, connect in the background -- means the container passes
   * its healthcheck, Compose declares it started, and the first real upload is
   * the thing that discovers Postgres was never reachable.
   */
  await db.connect();
  await db.applySchema();
  await s3.ensureBucket();
  await queue.connect();

  const app = createApp(services);
  const server = app.listen(env.port, () => {
    log.info(`listening on http://0.0.0.0:${env.port} (${env.nodeEnv})`);
  });

  installShutdownHandlers(server, services);
}

function installShutdownHandlers(server: Server, services: AppServices): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    // Docker sends SIGTERM and then SIGKILL. A second signal arriving mid
    // shutdown must not start a second teardown of the same resources.
    if (shuttingDown) {
      log.warn(`${signal} received again, shutdown already in progress`);
      return;
    }
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);

    // A client on a slow connection, or an in-flight S3 stream, must not be
    // able to hold the process open indefinitely.
    const killer = setTimeout(() => {
      log.error(`shutdown exceeded ${SHUTDOWN_GRACE_MS}ms, exiting anyway`);
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    killer.unref();

    try {
      // Stop accepting new work first, then release what the in-flight
      // requests were using. The reverse order would fail live requests.
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await services.queue.close();
      await services.db.close();
      services.s3.destroy();

      log.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      log.error('error during shutdown', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  /**
   * After either of these the process is in an undefined state: some
   * invariant the code relies on has already been violated. Logging and
   * exiting lets Compose's restart policy produce a clean process, which is
   * strictly better than continuing to serve from a corrupted one.
   */
  process.on('uncaughtException', (error) => {
    log.error('uncaught exception', error);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled promise rejection', reason);
    process.exit(1);
  });
}

main().catch((error) => {
  log.error('failed to start', error);
  process.exit(1);
});
