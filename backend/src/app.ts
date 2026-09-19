import cors from 'cors';
import express, { type Express } from 'express';

import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { createHealthRouter } from './routes/health';
import { createInferenceRouter } from './routes/inference';
import type { AppServices } from './services/container';
import { createLogger } from './utils/logger';

const log = createLogger('http');

/**
 * Builds the Express application from already-connected services.
 *
 * Kept separate from server.ts so that "wire up the routes" and "open a socket
 * and manage a process lifecycle" are two different concerns: this function is
 * synchronous, has no side effects beyond the object it returns, and can be
 * handed to a test harness as-is.
 */
export function createApp(services: AppServices): Express {
  const app = express();

  // Advertising the framework and version helps nobody but an attacker
  // fingerprinting for known CVEs.
  app.disable('x-powered-by');

  // nginx terminates the connection in Compose, so req.ip would otherwise be
  // the proxy's address on every single request.
  app.set('trust proxy', 1);

  app.use(cors({ origin: env.corsOrigin }));

  /**
   * Deliberately small. Images arrive as multipart and never pass through this
   * parser, so nothing legitimate needs a large JSON body -- and a generous
   * limit here would be an easy way to make the server allocate on demand.
   */
  app.use(express.json({ limit: '64kb' }));

  app.use(requestLogger);

  app.use('/health', createHealthRouter(services));
  app.use('/api', createInferenceRouter(services));

  // Order matters: the 404 handler has to come after every route, and the
  // error handler after everything, or Express will not reach them.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * One line per completed request.
 *
 * Hooked to the response's 'finish' event rather than wrapping `res.end`,
 * because that fires for every outcome including the streamed image responses
 * and the ones the error handler writes.
 */
const requestLogger: express.RequestHandler = (req, res, next) => {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    // Health probes fire every few seconds; logging them would drown out the
    // traffic anyone actually wants to read.
    if (req.originalUrl.startsWith('/health')) {
      return;
    }
    log.info(
      `${req.method} ${req.originalUrl} ${res.statusCode} ${elapsedMs.toFixed(1)}ms`,
    );
  });

  next();
};
