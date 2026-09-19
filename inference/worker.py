"""The consuming half of the queue + database architecture.

This process is the reason the design is "option 1" rather than an Express
server shelling out to Python. It is a long-lived container that owns a
loaded model, takes jobs from RabbitMQ at its own pace, and reports results by
writing to Postgres. It has no HTTP surface and the backend cannot call it;
the queue is the only thing they share.

Two consequences follow, and both are the point:

* Scaling is `docker compose up --scale worker=3`. Three replicas compete for
  the same queue, RabbitMQ hands each message to exactly one of them, and no
  other service needs to be told that the number changed.
* A worker crash loses nothing. An unacknowledged message is redelivered, and
  because the result write is an upsert keyed on the request id, the repeat is
  harmless.

Run it with:  python worker.py
"""

from __future__ import annotations

import json
import logging
import signal
import sys
import time
from typing import Any, Callable, NoReturn

import pika
import pika.exceptions
from pika.adapters.blocking_connection import BlockingChannel
from pika.spec import Basic, BasicProperties

from config import DEAD_LETTER_ROUTING_KEY, Settings, load_settings
from database import Database, DatabaseError, RequestNotFound
from engine import InferenceEngine, InvalidImage
from storage import ObjectNotFound, ObjectStorage, StorageError

log = logging.getLogger("worker")

INITIAL_RECONNECT_DELAY = 1.0
MAX_RECONNECT_DELAY = 15.0

# Well above the sub-second cost of a forward pass, so a job in progress can
# never be mistaken for a dead connection. Pika sends heartbeats from the same
# loop that runs the message callback, so this value is really "how long a
# single job may block before the broker gives up on us".
HEARTBEAT_SECONDS = 60


class MalformedJob(Exception):
    """The message body is not a job this worker can act on."""


class InferenceWorker:
    def __init__(
        self,
        settings: Settings,
        engine: InferenceEngine,
        storage: ObjectStorage,
        database: Database,
    ) -> None:
        self._settings = settings
        self._engine = engine
        self._storage = storage
        self._database = database

        self._connection: pika.BlockingConnection | None = None
        self._channel: BlockingChannel | None = None
        self._stopping = False

    # -- lifecycle ---------------------------------------------------------

    def run(self) -> None:
        """Consume until told to stop, reconnecting when the broker goes away.

        The reconnect loop is not redundant with Compose's `depends_on`. That
        only orders the *first* start; this is what survives a broker restart
        at three in the morning, when nothing is going to re-order anything.
        """
        signal.signal(signal.SIGTERM, self._handle_signal)
        signal.signal(signal.SIGINT, self._handle_signal)

        delay = INITIAL_RECONNECT_DELAY
        while not self._stopping:
            try:
                self._open()
                # Reset only after a connection that actually worked, so a
                # flapping broker still backs off instead of hammering.
                delay = INITIAL_RECONNECT_DELAY
                self._consume()
            except (
                pika.exceptions.AMQPConnectionError,
                pika.exceptions.AMQPChannelError,
                pika.exceptions.StreamLostError,
            ) as error:
                if self._stopping:
                    break
                log.warning("broker connection lost (%s); reconnecting in %.0fs", error, delay)
                time.sleep(delay)
                delay = min(delay * 2, MAX_RECONNECT_DELAY)
            finally:
                self._close_quietly()

        log.info("worker stopped")

    def _open(self) -> None:
        parameters = pika.URLParameters(self._settings.rabbit_url)
        parameters.heartbeat = HEARTBEAT_SECONDS
        parameters.blocked_connection_timeout = 30
        # One attempt per call: the retry policy lives in run(), and letting
        # pika also retry would multiply the two into a confusing schedule.
        parameters.connection_attempts = 1

        self._connection = pika.BlockingConnection(parameters)
        self._channel = self._connection.channel()
        self._declare_topology(self._channel)

        # Without this the broker would push the whole queue at one worker the
        # moment it connects, and the other replicas would sit idle holding
        # messages they were never offered. prefetch=1 means a replica is
        # handed the next job only once it has finished the last, which is
        # exactly the fair-share behaviour that makes scaling out work.
        self._channel.basic_qos(prefetch_count=self._settings.prefetch)

        log.info("connected to the broker, consuming %r", self._settings.queue)

    def _declare_topology(self, channel: BlockingChannel) -> None:
        """Declare the same topology the backend declares.

        Both sides do this because either may start first. The declarations
        must match exactly -- RabbitMQ answers a redeclaration with different
        arguments with PRECONDITION_FAILED and closes the channel -- so this
        block and openChannel() in backend/src/services/queueService.ts have
        to be changed together.
        """
        channel.exchange_declare(
            exchange=self._settings.dead_letter_exchange,
            exchange_type="direct",
            durable=True,
        )
        channel.queue_declare(queue=self._settings.dead_letter_queue, durable=True)
        channel.queue_bind(
            queue=self._settings.dead_letter_queue,
            exchange=self._settings.dead_letter_exchange,
            routing_key=DEAD_LETTER_ROUTING_KEY,
        )
        channel.queue_declare(
            queue=self._settings.queue,
            durable=True,
            arguments={
                "x-dead-letter-exchange": self._settings.dead_letter_exchange,
                "x-dead-letter-routing-key": DEAD_LETTER_ROUTING_KEY,
            },
        )

    def _consume(self) -> None:
        assert self._channel is not None
        self._channel.basic_consume(
            queue=self._settings.queue,
            on_message_callback=self._on_message,
        )
        log.info("waiting for jobs")
        self._channel.start_consuming()

    def _handle_signal(self, signum: int, _frame: Any) -> None:
        """Ask the consumer to stop after the job currently in flight.

        `stop_consuming` is scheduled onto the connection's own loop rather
        than called here. A signal handler runs between bytecodes of whatever
        the interpreter was doing, which may be the middle of pika's frame
        handling, and pika's blocking adapter is explicitly not safe to touch
        from there.
        """
        self._stopping = True
        log.info("%s received, finishing the current job", signal.Signals(signum).name)
        connection = self._connection
        if connection is not None and connection.is_open:
            try:
                connection.add_callback_threadsafe(self._stop_consuming)
            except Exception:  # noqa: BLE001 - shutting down; nothing to salvage
                pass

    def _stop_consuming(self) -> None:
        if self._channel is not None and self._channel.is_open:
            self._channel.stop_consuming()

    def _close_quietly(self) -> None:
        try:
            if self._connection is not None and self._connection.is_open:
                self._connection.close()
        except Exception as error:  # noqa: BLE001 - a broker already gone is fine
            log.debug("ignoring error while closing the connection: %s", error)
        finally:
            self._connection = None
            self._channel = None

    # -- message handling --------------------------------------------------

    def _on_message(
        self,
        channel: BlockingChannel,
        method: Basic.Deliver,
        _properties: BasicProperties,
        body: bytes,
    ) -> None:
        try:
            request_id, image_key = parse_job(body)
        except MalformedJob as error:
            # Nothing identifies the job, so there is no row to fail and no
            # point retrying. Dead-letter it so the bad message is preserved
            # for inspection rather than silently dropped.
            log.error("discarding unreadable message: %s", error)
            channel.basic_nack(method.delivery_tag, requeue=False)
            return

        try:
            self._database.mark_processing(request_id)
            image = self._storage.download(image_key)
            prediction = self._engine.classify_bytes(image)
            self._database.save_success(
                request_id=request_id,
                predicted_class=prediction.predicted_class,
                confidence=prediction.confidence,
                probabilities=prediction.probabilities,
                model_arch=self._engine.arch,
                model_val_acc=self._engine.val_acc,
                duration_ms=prediction.duration_ms,
            )
            channel.basic_ack(method.delivery_tag)
            log.info(
                "%s -> %s (%.2f%%) in %dms",
                request_id,
                prediction.predicted_class,
                prediction.confidence * 100,
                prediction.duration_ms,
            )

        # Permanent failures first. ObjectNotFound subclasses StorageError, so
        # this clause has to precede the transient one or a missing object
        # would be retried as though the store were merely unreachable.
        except (InvalidImage, ObjectNotFound, RequestNotFound) as error:
            log.error("%s failed permanently: %s%s", request_id, error, describe_cause(error))
            self._fail(channel, method, request_id, user_message(error))

        except (StorageError, DatabaseError) as error:
            # A dependency blinked. Give the job exactly one more attempt, and
            # use the broker's own redelivered flag to count it so no state has
            # to be carried anywhere.
            #
            # Honest limitation: the retry is immediate, because sleeping here
            # would block the connection's heartbeat. A system that needed
            # real backoff would republish to a delay queue with a TTL rather
            # than requeue in place.
            if not method.redelivered:
                log.warning("%s hit a transient error (%s); requeueing once", request_id, error)
                channel.basic_nack(method.delivery_tag, requeue=True)
                return
            log.error("%s failed again after a retry: %s", request_id, error)
            self._fail(channel, method, request_id, user_message(error))

        except Exception as error:  # noqa: BLE001 - the catch-all is the point
            # An unexpected exception must not kill the consumer: one bad
            # message would otherwise take down a worker that is perfectly
            # capable of handling every other job in the queue.
            #
            # The traceback goes to the log; the browser gets a sentence. An
            # arbitrary exception's str() is written for a developer and can
            # carry connection strings and internal paths.
            log.exception("%s raised an unexpected error", request_id)
            self._fail(channel, method, request_id, user_message(error))

    def _fail(
        self,
        channel: BlockingChannel,
        method: Basic.Deliver,
        request_id: str,
        message: str,
    ) -> None:
        """Record a terminal failure and dead-letter the message."""
        try:
            self._database.mark_failed(request_id, message)
        except DatabaseError as error:
            # The browser will keep polling a row stuck at 'processing'. There
            # is nothing better available here -- the database is the only
            # place that answer could be written.
            log.error("could not record the failure of %s: %s", request_id, error)

        channel.basic_nack(method.delivery_tag, requeue=False)


def user_message(error: Exception) -> str:
    """The sentence a person will read in the browser.

    `error_message` is rendered in the UI, so it is a user-facing string and
    has to be written like one. An exception's own text is written for whoever
    is reading the log -- it carries stream reprs, bucket names, driver output
    and occasionally a connection string, none of which belong in a web page.
    The technical version is logged next to every call of this function.

    ObjectNotFound is checked before StorageError because it is a subclass of
    it, exactly as in the except clauses above.
    """
    if isinstance(error, InvalidImage):
        return "The image could not be decoded. It may be truncated, or saved in a format the model cannot read."
    if isinstance(error, ObjectNotFound):
        return "The uploaded image is no longer in storage."
    if isinstance(error, RequestNotFound):
        return "The record for this request no longer exists."
    if isinstance(error, StorageError):
        return "The image store could not be reached. Please try again."
    if isinstance(error, DatabaseError):
        return "The database could not be reached. Please try again."
    return "The prediction failed unexpectedly. The worker log has the details."


def describe_cause(error: Exception) -> str:
    """The original exception a clean message was raised `from`, for the log."""
    cause = error.__cause__
    return f" (cause: {cause})" if cause is not None else ""


def parse_job(body: bytes) -> tuple[str, str]:
    """Validate the message published by backend/src/services/queueService.ts."""
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise MalformedJob(f"body is not valid JSON: {error}") from error

    if not isinstance(payload, dict):
        raise MalformedJob(f"body is a {type(payload).__name__}, expected an object")

    request_id = payload.get("requestId")
    image_key = payload.get("imageKey")
    if not isinstance(request_id, str) or not request_id:
        raise MalformedJob("requestId is missing or not a string")
    if not isinstance(image_key, str) or not image_key:
        raise MalformedJob("imageKey is missing or not a string")

    return request_id, image_key


def wait_for(check: Callable[[], None], name: str, attempts: int = 30, delay: float = 2.0) -> None:
    """Block until a dependency answers, or give up loudly.

    Compose gates startup on healthchecks, so this rarely runs more than once.
    It earns its place when the worker is started by hand, and when a
    dependency is still replaying its log after a restart.
    """
    for attempt in range(1, attempts + 1):
        try:
            check()
            log.info("%s is ready", name)
            return
        except Exception as error:  # noqa: BLE001 - every failure is retryable here
            if attempt == attempts:
                raise RuntimeError(f"{name} never became ready: {error}") from error
            log.warning("%s not ready (%d/%d): %s", name, attempt, attempts, error)
            time.sleep(delay)


def configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        # Deliberately close to the backend's format so the two services read
        # as one timeline in `docker compose logs`.
        format="%(asctime)s %(levelname)-5s [%(name)s] %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
        stream=sys.stdout,
    )
    # Pika logs every frame at DEBUG and a good deal at INFO; at this volume
    # it would bury the worker's own output.
    logging.getLogger("pika").setLevel(logging.WARNING)


def main() -> NoReturn:
    configure_logging()
    settings = load_settings()

    # The model loads before anything is consumed, so the worker is warm by
    # the time it accepts a job and the first upload of the day is not the one
    # that pays for the checkpoint read.
    log.info("loading checkpoint from %s", settings.model_path)
    engine = InferenceEngine(settings.model_path, settings.torch_threads)
    log.info(
        "model ready: %s, classes %s, checkpoint val_acc %s",
        engine.arch,
        ", ".join(engine.class_names),
        f"{engine.val_acc * 100:.2f}%" if engine.val_acc is not None else "unknown",
    )

    storage = ObjectStorage(settings)
    database = Database(settings)
    wait_for(database.ping, "postgres")
    wait_for(storage.ping, "s3")

    InferenceWorker(settings, engine, storage, database).run()
    sys.exit(0)


if __name__ == "__main__":
    main()
