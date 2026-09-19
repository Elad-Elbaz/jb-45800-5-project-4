-- Schema for the asynchronous inference pipeline.
--
-- Two writers share these tables and never contend:
--   * the Express backend INSERTs a request when an image is uploaded, and
--     only ever reads afterwards;
--   * the Python worker UPDATEs the status and INSERTs the result.
--
-- Every statement is idempotent so the backend can apply this file on each
-- boot (see DatabaseService.applySchema). That is deliberately more robust
-- than Postgres' docker-entrypoint-initdb.d, which runs only when the data
-- volume is empty and therefore silently skips an already-deployed database.

-- ---------------------------------------------------------------------------
-- One row per uploaded image. This table is the source of truth the browser
-- polls: the queue is a transport, not a record. If RabbitMQ lost every
-- message right now, nothing a user submitted would disappear from here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inference_requests (
    -- The UUID the backend generates before anything is persisted, so the
    -- client is handed a tracking id by the very request that uploads the
    -- image. It is the natural key, so there is no second surrogate id.
    request_id    UUID        PRIMARY KEY,
    -- Object key inside the S3 bucket, not a local path: the worker runs in a
    -- different container and shares no filesystem with the backend.
    image_key     TEXT        NOT NULL,
    original_name TEXT        NOT NULL,
    content_type  TEXT        NOT NULL,
    size_bytes    INTEGER     NOT NULL CHECK (size_bytes > 0),
    status        TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    -- Populated only when status = 'failed'. Successful runs leave it NULL,
    -- which is why the error does not live on inference_results.
    error_message TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at    TIMESTAMPTZ,
    completed_at  TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- The prediction itself, kept in its own table rather than folded into the
-- request: a result exists only for a run that actually succeeded, and a
-- failed job has no class and no probabilities to store. Sharing the primary
-- key makes the worker's write idempotent for free, which matters because
-- RabbitMQ redelivers an unacknowledged message after a worker crash.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inference_results (
    request_id      UUID         PRIMARY KEY
                                 REFERENCES inference_requests (request_id) ON DELETE CASCADE,
    predicted_class TEXT         NOT NULL,
    confidence      NUMERIC(6,5) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    -- {"paper": 0.98, "rock": 0.01, "scissors": 0.01} -- the full softmax row,
    -- so the UI can draw the distribution and not just the winner.
    probabilities   JSONB        NOT NULL,
    -- Provenance of the checkpoint that produced this row, read straight out
    -- of the .pt file. Swapping in a retrained model stays traceable in data.
    model_arch      TEXT         NOT NULL,
    model_val_acc   NUMERIC(6,5),
    -- Wall-clock time of the forward pass, which is what answers "do we need
    -- more workers?".
    duration_ms     INTEGER      NOT NULL CHECK (duration_ms >= 0),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- The history page reads newest-first; request_id is already indexed by its
-- primary key, so only the ordering column needs help.
CREATE INDEX IF NOT EXISTS idx_inference_requests_created_at
    ON inference_requests (created_at DESC);
