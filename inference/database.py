"""The worker's writes to Postgres.

This module owns every status transition after a job is queued. The backend
inserts the row as 'pending' and then only reads; from that point the
lifecycle belongs here. Keeping the two writers on disjoint columns and
disjoint moments is what makes "who set this row to failed?" answerable by
reading one file.

Connections are opened per operation rather than held open for the life of the
process. A worker performs two or three short statements per job with a
forward pass in between, so pooling would save a few milliseconds on a task
measured in hundreds -- and a long-lived connection would add a genuine
failure mode, the stale socket that only reveals itself on the next job after
a database restart.
"""

from __future__ import annotations

import psycopg
from psycopg.types.json import Jsonb

from config import Settings


class DatabaseError(Exception):
    """Postgres was unreachable or rejected a statement. Transient."""


class RequestNotFound(Exception):
    """The queued job names a row that does not exist.

    Permanent: a retry looks for the same absent row. Reachable if the
    database was reset while messages were still sitting in the queue.
    """


class Database:
    def __init__(self, settings: Settings) -> None:
        self._dsn = settings.database_url

    def _connect(self) -> psycopg.Connection:
        try:
            return psycopg.connect(self._dsn, connect_timeout=10)
        except psycopg.Error as error:
            raise DatabaseError(f"cannot connect to Postgres: {error}") from error

    def ping(self) -> None:
        """Fail fast at startup rather than on the first real job."""
        try:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute("SELECT 1")
        except psycopg.Error as error:
            raise DatabaseError(f"Postgres health check failed: {error}") from error

    def mark_processing(self, request_id: str) -> None:
        """Claim the job, and confirm the row it refers to is really there.

        The rowcount check is the reason this is not a fire-and-forget UPDATE:
        without it a message pointing at a deleted row would sail on to the
        download and the forward pass, and only fail when the result had
        nowhere to go -- after the expensive part.
        """
        try:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE inference_requests
                       SET status = 'processing', started_at = NOW()
                     WHERE request_id = %s
                    """,
                    (request_id,),
                )
                if cur.rowcount == 0:
                    raise RequestNotFound(f"no inference_requests row for {request_id}")
        except psycopg.Error as error:
            raise DatabaseError(f"could not mark {request_id} processing: {error}") from error

    def save_success(
        self,
        request_id: str,
        predicted_class: str,
        confidence: float,
        probabilities: dict[str, float],
        model_arch: str,
        model_val_acc: float | None,
        duration_ms: int,
    ) -> None:
        """Record the prediction and complete the request, atomically.

        Both statements share one transaction so the pair can never be
        half-applied. A row marked 'completed' with no result would be
        unreadable by the API -- it promises a prediction for that status --
        and a result attached to a row still marked 'processing' would leave
        the browser polling forever for something already computed.

        The upsert makes redelivery harmless. RabbitMQ redelivers any message
        a worker did not acknowledge, so a crash in the microseconds between
        the commit here and the ack in worker.py means this runs twice.
        """
        try:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO inference_results
                        (request_id, predicted_class, confidence, probabilities,
                         model_arch, model_val_acc, duration_ms)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (request_id) DO UPDATE
                        SET predicted_class = EXCLUDED.predicted_class,
                            confidence      = EXCLUDED.confidence,
                            probabilities   = EXCLUDED.probabilities,
                            model_arch      = EXCLUDED.model_arch,
                            model_val_acc   = EXCLUDED.model_val_acc,
                            duration_ms     = EXCLUDED.duration_ms,
                            created_at      = NOW()
                    """,
                    (
                        request_id,
                        predicted_class,
                        confidence,
                        Jsonb(probabilities),
                        model_arch,
                        model_val_acc,
                        duration_ms,
                    ),
                )
                cur.execute(
                    """
                    UPDATE inference_requests
                       SET status = 'completed', completed_at = NOW(), error_message = NULL
                     WHERE request_id = %s
                    """,
                    (request_id,),
                )
        except psycopg.Error as error:
            raise DatabaseError(f"could not save result for {request_id}: {error}") from error

    def mark_failed(self, request_id: str, message: str) -> None:
        """Give the browser a terminal answer instead of an endless spinner."""
        try:
            with self._connect() as conn, conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE inference_requests
                       SET status = 'failed', error_message = %s, completed_at = NOW()
                     WHERE request_id = %s
                    """,
                    # Bounded: the column is unconstrained TEXT, but an
                    # exception chain from a driver can run to kilobytes and
                    # this string is rendered in a browser.
                    (message[:1000], request_id),
                )
        except psycopg.Error as error:
            raise DatabaseError(f"could not mark {request_id} failed: {error}") from error
