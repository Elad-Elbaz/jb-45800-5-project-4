/**
 * The four operations the browser performs: submit an image, poll one job,
 * list recent jobs, and fetch the stored image back.
 *
 * No controller here waits for a prediction. Submitting returns
 * 202 Accepted with a tracking id, and the client polls; the actual work
 * happens in a different container, at whatever pace it happens.
 */

import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

import type { RequestHandler } from 'express';

import type { DatabaseService } from '../services/databaseService';
import type { QueueService } from '../services/queueService';
import type { S3Service } from '../services/s3Service';
import type { InferenceJobDto, InferenceListDto, UploadAcceptedDto } from '../models/types';
import { ApiError } from '../utils/apiError';
import { asyncHandler } from '../utils/asyncHandler';
import { SUPPORTED_IMAGE_FORMATS, detectImageType } from '../utils/imageType';
import { createLogger } from '../utils/logger';

const log = createLogger('inference');

const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;

/** RFC 4122 shape. Any version, since the check exists for a different reason. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InferenceController {
  constructor(
    private readonly db: DatabaseService,
    private readonly queue: QueueService,
    private readonly s3: S3Service,
  ) {}

  /**
   * POST /api/inference
   *
   * The ordering of the three writes is deliberate and not interchangeable:
   *
   *   1. the image goes to S3, so the key the message carries already resolves;
   *   2. the row goes to Postgres, so the job the message names already exists;
   *   3. the message goes to RabbitMQ, last, so a worker cannot win the race
   *      and find either of the first two missing.
   *
   * Reversing any pair produces a real, reproducible bug rather than a
   * theoretical one, because the worker is a separate process that may pick up
   * the message within microseconds of it being published.
   */
  readonly create: RequestHandler = asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) {
      throw ApiError.badRequest(
        'No image uploaded. Send multipart/form-data with an "image" field.',
      );
    }

    // The declared MIME type got the request this far; the bytes decide
    // whether it goes any further.
    const detected = detectImageType(file.buffer);
    if (!detected) {
      throw ApiError.unsupportedMediaType(
        `That file is not a readable image. Supported formats: ${SUPPORTED_IMAGE_FORMATS}.`,
      );
    }

    const requestId = randomUUID();
    const imageKey = this.s3.buildKey(requestId, detected.extension);

    await this.s3.putImage(imageKey, file.buffer, detected.mime);
    await this.db.createRequest({
      requestId,
      imageKey,
      originalName: safeFilename(file.originalname),
      contentType: detected.mime,
      sizeBytes: file.size,
    });

    try {
      await this.queue.publishJob({ requestId, imageKey, contentType: detected.mime });
    } catch (error) {
      /**
       * The row exists but no worker will ever be told about it. Failing it
       * here is what keeps the client from polling `pending` forever, and it
       * is the reason the backend owns a `markFailed` at all.
       */
      await this.db.markFailed(requestId, 'The job could not be queued for inference.');
      log.error(`could not publish ${requestId}`, error);
      throw ApiError.serviceUnavailable(
        'The inference queue is unavailable. The upload was saved but not scheduled; please retry.',
      );
    }

    log.info(`queued ${requestId} (${detected.mime}, ${file.size} bytes)`);

    const body: UploadAcceptedDto = {
      requestId,
      status: 'pending',
      statusUrl: `/api/inference/${requestId}`,
    };
    // 202, not 201: the prediction this request is about does not exist yet.
    res.status(202).json(body);
  });

  /** GET /api/inference/:requestId -- the endpoint the client polls. */
  readonly findOne: RequestHandler = asyncHandler(async (req, res) => {
    const requestId = requireUuid(req.params.requestId);

    const job = await this.db.findRequest(requestId);
    if (!job) {
      throw ApiError.notFound(`No inference request with id ${requestId}`);
    }

    const body: InferenceJobDto = job;
    res.json(body);
  });

  /** GET /api/inference?limit=20 -- newest first, for the history page. */
  readonly list: RequestHandler = asyncHandler(async (req, res) => {
    const limit = parseLimit(req.query.limit);
    const body: InferenceListDto = { items: await this.db.listRequests(limit) };
    res.json(body);
  });

  /**
   * GET /api/inference/:requestId/image
   *
   * Serves the stored image through the API rather than handing the browser a
   * presigned S3 URL. A presigned URL would be signed for `http://localstack`,
   * a hostname that exists only on the Compose network and that the user's
   * browser cannot resolve. Proxying keeps every URL the client sees on one
   * origin, and keeps the bucket entirely private.
   */
  readonly findImage: RequestHandler = asyncHandler(async (req, res) => {
    const requestId = requireUuid(req.params.requestId);

    const location = await this.db.findImageLocation(requestId);
    if (!location) {
      throw ApiError.notFound(`No inference request with id ${requestId}`);
    }

    const stored = await this.s3.getImage(location.imageKey);
    if (!stored) {
      // The row outlived its object. Postgres persists across a
      // `docker compose down`; LocalStack's community edition cannot persist a
      // bucket, so historical rows can genuinely point at nothing.
      throw ApiError.notFound('The stored image for this request is no longer available.');
    }

    res.setHeader('Content-Type', location.contentType);
    if (stored.contentLength !== undefined) {
      res.setHeader('Content-Length', String(stored.contentLength));
    }
    // An object is written once under a key derived from an immutable request
    // id, so it can never change. Caching it is free correctness.
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');

    // pipeline, not pipe: it propagates errors to the caller and destroys both
    // streams on failure, so a client that disconnects mid-download cannot
    // leave the S3 socket open.
    await pipeline(stored.body, res);
  });
}

/**
 * Rejects a malformed id before it reaches SQL.
 *
 * `WHERE request_id = $1` against a UUID column raises invalid_text_
 * representation for any non-UUID input, which would surface as a 500 for what
 * is plainly a bad request. Checking the shape first keeps the status honest.
 */
function requireUuid(value: string | undefined): string {
  if (!value || !UUID_PATTERN.test(value)) {
    throw ApiError.badRequest('Request id must be a UUID.');
  }
  return value;
}

function parseLimit(raw: unknown): number {
  if (raw === undefined) {
    return DEFAULT_HISTORY_LIMIT;
  }
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw ApiError.badRequest('limit must be a positive integer.');
  }
  // Clamped rather than rejected: a caller asking for too much gets the most
  // the server is willing to serve, and cannot turn the endpoint into a way to
  // read the entire table in one request.
  return Math.min(parsed, MAX_HISTORY_LIMIT);
}

/**
 * Makes a client-supplied filename safe to store and display.
 *
 * React escapes interpolated text, so this is not the XSS boundary; it is
 * about not persisting control characters or path separators that would be
 * confusing in a log line or a future download header.
 */
function safeFilename(original: string): string {
  const cleaned = original
    // C0 controls and DEL, written as escapes so this source file never
    // contains a raw control byte itself. Newlines matter most: a filename
    // carrying one could otherwise forge an extra line in the log output.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .trim();
  return cleaned.slice(0, 255) || 'upload';
}
