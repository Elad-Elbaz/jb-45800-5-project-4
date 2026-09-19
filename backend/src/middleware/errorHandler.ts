/**
 * The single place an HTTP error response is produced.
 *
 * Controllers throw; nothing else writes an error body. That is what makes
 * "an internal error never leaks a stack trace or a driver message to the
 * client" checkable by reading one file instead of auditing every route.
 */

import type { ErrorRequestHandler, RequestHandler } from 'express';
import { MulterError } from 'multer';

import { env, isProduction } from '../config/env';
import { ApiError } from '../utils/apiError';
import type { ErrorDto } from '../models/types';
import { createLogger } from '../utils/logger';

const log = createLogger('http');

/** Anything that reached the end of the router matched no route. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(ApiError.notFound(`No route matches ${req.method} ${req.originalUrl}`));
};

export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  /**
   * The image route streams its body, so a failure can arrive after the status
   * line and headers are already on the wire. There is no valid JSON response
   * left to send at that point; the only correct move is to hand back to
   * Express, which destroys the socket so the client sees a truncated
   * response rather than a 200 with corrupt content.
   */
  if (res.headersSent) {
    log.error(`${req.method} ${req.originalUrl} failed mid-response`, error);
    next(error);
    return;
  }

  const { status, body } = toResponse(error);

  if (status >= 500) {
    // Only 5xx carries a stack: a 400 is the client's business, not an
    // incident, and logging it at the same volume buries the real failures.
    log.error(`${req.method} ${req.originalUrl} -> ${status}`, error);
  } else {
    log.warn(`${req.method} ${req.originalUrl} -> ${status}: ${body.message}`);
  }

  res.status(status).json(body);
};

function toResponse(error: unknown): { status: number; body: ErrorDto } {
  if (error instanceof ApiError) {
    return { status: error.status, body: { error: error.code, message: error.message } };
  }

  if (error instanceof MulterError) {
    return { status: multerStatus(error), body: { error: error.code, message: multerMessage(error) } };
  }

  return {
    status: 500,
    body: {
      error: 'internal_error',
      message: isProduction
        ? 'The server failed to handle the request.'
        : // Outside production the real message is far more useful than a
          // sanitised one, and there is no untrusted audience to protect from.
          (error instanceof Error ? error.message : String(error)),
    },
  };
}

function multerStatus(error: MulterError): number {
  return error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
}

function multerMessage(error: MulterError): string {
  switch (error.code) {
    case 'LIMIT_FILE_SIZE': {
      const megabytes = (env.maxUploadBytes / (1024 * 1024)).toFixed(1);
      return `Image is larger than the ${megabytes} MB limit.`;
    }
    case 'LIMIT_UNEXPECTED_FILE':
      return `Unexpected form field "${error.field}".`;
    case 'LIMIT_FILE_COUNT':
      return 'Upload one image at a time.';
    default:
      return error.message;
  }
}
