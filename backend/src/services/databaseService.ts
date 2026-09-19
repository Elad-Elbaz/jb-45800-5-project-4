/**
 * The backend's entire relationship with Postgres.
 *
 * Every SQL statement the API issues lives in this file. Controllers receive
 * DTOs and never see a row, a column name or a `pg` type, so the database
 * schema can change without a controller changing with it.
 *
 * Note what is *not* here: nothing writes a status transition or a result.
 * Those are the Python worker's job (inference/database.py). The backend
 * inserts a request and reads afterwards -- with the single exception of
 * `markFailed`, which covers the case where the job never reached the broker
 * at all and therefore no worker will ever touch the row.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { Pool, types } from 'pg';

import type {
  InferenceJobDto,
  InferenceJoinedRow,
  InferenceRequestRow,
  PredictionDto,
} from '../models/types';
import { createLogger, describeError } from '../utils/logger';

const log = createLogger('database');

/**
 * Postgres NUMERIC arrives as a *string* by default, because it can hold
 * values no IEEE-754 double can represent. `confidence` and `model_val_acc`
 * are bounded in [0, 1], so that risk does not apply and a silent
 * `"0.98765"` leaking into JSON would be worse: the React app would render a
 * string where it expects a number, and `toFixed` would throw. Registering the
 * parser once, at module load, fixes it for every query in the process.
 */
types.setTypeParser(types.builtins.NUMERIC, (value: string) => Number.parseFloat(value));

/** Columns of the request/result join, written once and reused by both reads. */
const SELECT_JOINED = `
  SELECT req.request_id,
         req.image_key,
         req.original_name,
         req.content_type,
         req.size_bytes,
         req.status,
         req.error_message,
         req.created_at,
         req.started_at,
         req.completed_at,
         res.predicted_class,
         res.confidence,
         res.probabilities,
         res.model_arch,
         res.model_val_acc,
         res.duration_ms
    FROM inference_requests req
    LEFT JOIN inference_results res ON res.request_id = req.request_id
`;

export interface NewInferenceRequest {
  requestId: string;
  imageKey: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
}

/** Where the bytes for a request live, for the image-download route. */
export interface StoredImageLocation {
  imageKey: string;
  contentType: string;
}

export class DatabaseService {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      // Small on purpose: this API is I/O-bound on the queue and on S3, not on
      // Postgres, and an oversized pool mostly buys idle connections.
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    // An idle client can fail on its own (Postgres restart, network blip).
    // Unhandled, that 'error' event takes the whole process down, so the pool
    // must always have a listener even when no query is in flight.
    this.pool.on('error', (error) => {
      log.error('idle client error (the pool will replace it)', error);
    });
  }

  /**
   * Waits for Postgres to accept a query, retrying with linear backoff.
   *
   * Compose already gates startup on a `pg_isready` healthcheck, so in the
   * normal path the first attempt succeeds. This exists for the paths Compose
   * does not cover: `npm run dev` against a container that is still booting,
   * and a Postgres restart underneath a running backend.
   */
  async connect(attempts = 10, delayMs = 1_000): Promise<void> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.pool.query('SELECT 1');
        log.info('connected');
        return;
      } catch (error) {
        if (attempt === attempts) {
          throw new Error(
            `Postgres unreachable after ${attempts} attempts: ${describeError(error)}`,
          );
        }
        log.warn(`not ready (attempt ${attempt}/${attempts}), retrying in ${delayMs}ms`);
        await new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
    }
  }

  /**
   * Applies db/schema.sql. Every statement in it is `IF NOT EXISTS`, so this
   * is safe to run on every boot and on an already-populated database.
   *
   * The file sits next to the compiled output at dist/db/schema.sql (see the
   * `build` script), which is why `__dirname` resolves it correctly under both
   * `tsx src/server.ts` and `node dist/server.js`.
   */
  async applySchema(): Promise<void> {
    const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
    const sql = await fs.readFile(schemaPath, 'utf8');
    await this.pool.query(sql);
    log.info('schema applied');
  }

  /** Cheap liveness probe for the readiness endpoint. */
  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  /**
   * Records an upload as `pending`.
   *
   * This happens *before* the job is published, so a message can never
   * reference a row that does not exist. The reverse ordering would let a
   * worker win the race and try to update nothing.
   */
  async createRequest(request: NewInferenceRequest): Promise<InferenceRequestRow> {
    const { rows } = await this.pool.query<InferenceRequestRow>(
      `INSERT INTO inference_requests
         (request_id, image_key, original_name, content_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        request.requestId,
        request.imageKey,
        request.originalName,
        request.contentType,
        request.sizeBytes,
      ],
    );
    return rows[0];
  }

  /**
   * Fails a request the backend could not hand off.
   *
   * Only reachable when publishing to RabbitMQ failed. Without it the row
   * would sit at `pending` forever and the browser would poll a job that no
   * worker has ever been told about.
   */
  async markFailed(requestId: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE inference_requests
          SET status = 'failed', error_message = $2, completed_at = NOW()
        WHERE request_id = $1`,
      [requestId, message],
    );
  }

  async findRequest(requestId: string): Promise<InferenceJobDto | null> {
    const { rows } = await this.pool.query<InferenceJoinedRow>(
      `${SELECT_JOINED} WHERE req.request_id = $1`,
      [requestId],
    );
    return rows.length > 0 ? toJobDto(rows[0]) : null;
  }

  /** Newest-first page for the history view. */
  async listRequests(limit: number): Promise<InferenceJobDto[]> {
    const { rows } = await this.pool.query<InferenceJoinedRow>(
      `${SELECT_JOINED} ORDER BY req.created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map(toJobDto);
  }

  /**
   * Resolves a request to its object in S3.
   *
   * Separate from `findRequest` because `image_key` is internal storage
   * layout: the DTO the browser receives deliberately does not expose it, so
   * the bucket's naming scheme never becomes part of the public contract.
   */
  async findImageLocation(requestId: string): Promise<StoredImageLocation | null> {
    const { rows } = await this.pool.query<{ image_key: string; content_type: string }>(
      'SELECT image_key, content_type FROM inference_requests WHERE request_id = $1',
      [requestId],
    );
    return rows.length > 0
      ? { imageKey: rows[0].image_key, contentType: rows[0].content_type }
      : null;
  }

  async close(): Promise<void> {
    await this.pool.end();
    log.info('pool closed');
  }
}

/**
 * Turns one joined row into the JSON the API promises.
 *
 * The result half of the join is null for every request that has not finished,
 * and `predicted_class` is the column that decides: it is NOT NULL in
 * inference_results, so its presence means a result row genuinely exists
 * rather than merely having been left empty.
 */
function toJobDto(row: InferenceJoinedRow): InferenceJobDto {
  const prediction: PredictionDto | null =
    row.predicted_class === null
      ? null
      : {
          predictedClass: row.predicted_class,
          confidence: row.confidence ?? 0,
          probabilities: row.probabilities ?? {},
          modelArch: row.model_arch ?? 'unknown',
          modelValAcc: row.model_val_acc,
          durationMs: row.duration_ms ?? 0,
        };

  return {
    requestId: row.request_id,
    status: row.status,
    originalName: row.original_name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    errorMessage: row.error_message,
    prediction,
  };
}
