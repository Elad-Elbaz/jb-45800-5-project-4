/**
 * Every shape that crosses a boundary: the database rows, the JSON the browser
 * receives, and the message the Python worker consumes.
 *
 * Two naming conventions live here on purpose. Rows keep Postgres'
 * `snake_case` because that is literally what the driver returns; the DTOs the
 * API emits use `camelCase` because that is what TypeScript and the React app
 * expect. The mapping between them happens once, in DatabaseService, so the
 * seam is a single function rather than a convention every caller must recall.
 */

/** The lifecycle of a single upload. Mirrors the CHECK constraint in schema.sql. */
export type InferenceStatus = 'pending' | 'processing' | 'completed' | 'failed';

// ---------------------------------------------------------------------------
// Database rows -- exactly as `pg` hands them back.
// ---------------------------------------------------------------------------

export interface InferenceRequestRow {
  request_id: string;
  image_key: string;
  original_name: string;
  content_type: string;
  size_bytes: number;
  status: InferenceStatus;
  error_message: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

export interface InferenceResultRow {
  request_id: string;
  predicted_class: string;
  confidence: number;
  probabilities: Record<string, number>;
  model_arch: string;
  model_val_acc: number | null;
  duration_ms: number;
  created_at: Date;
}

/** The shape of the LEFT JOIN that reads a request and its (optional) result. */
export interface InferenceJoinedRow extends InferenceRequestRow {
  predicted_class: string | null;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  model_arch: string | null;
  model_val_acc: number | null;
  duration_ms: number | null;
}

// ---------------------------------------------------------------------------
// API payloads -- what the React app actually sees.
// ---------------------------------------------------------------------------

export interface PredictionDto {
  predictedClass: string;
  /** Softmax probability of the winning class, in [0, 1]. */
  confidence: number;
  /** The full distribution, e.g. { paper: 0.98, rock: 0.01, scissors: 0.01 }. */
  probabilities: Record<string, number>;
  modelArch: string;
  /** Validation accuracy recorded in the checkpoint, or null if absent. */
  modelValAcc: number | null;
  durationMs: number;
}

export interface InferenceJobDto {
  requestId: string;
  status: InferenceStatus;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  /** ISO-8601. Dates are serialised explicitly so the contract is stable. */
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  /** Non-null only once `status` is 'completed'. */
  prediction: PredictionDto | null;
}

export interface UploadAcceptedDto {
  requestId: string;
  status: Extract<InferenceStatus, 'pending'>;
  /** Where to poll. Saves the client from rebuilding the URL by hand. */
  statusUrl: string;
}

export interface InferenceListDto {
  items: InferenceJobDto[];
}

export interface ErrorDto {
  error: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Queue contract.
// ---------------------------------------------------------------------------

/**
 * The message body published to RabbitMQ, and the only thing the Python worker
 * is told about a job.
 *
 * It carries an object key rather than the image itself: bytes belong in S3,
 * not in a broker whose memory is shared by every queued message. It also
 * carries no prediction fields -- the worker writes those to Postgres, and the
 * queue never becomes a second, competing record of the outcome.
 *
 * The Python side of this contract is inference/worker.py.
 */
export interface InferenceJobMessage {
  requestId: string;
  imageKey: string;
  contentType: string;
}
