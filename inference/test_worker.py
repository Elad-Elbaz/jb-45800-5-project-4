"""Tests for the worker's message-handling decisions.

    cd inference && pip install -r requirements-dev.txt && pytest

The branch that chooses between acknowledge, requeue and dead-letter is the
part of this project most likely to be wrong in a way nothing notices. Every
path "works" in the sense that the callback returns; only the wrong ones lose
a recoverable job or retry an impossible one forever. These tests drive each
branch directly, with fakes in place of the broker, the bucket and the
database, so a regression shows up here rather than in production traffic.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import pytest

import config
from config import Settings
from database import DatabaseError, RequestNotFound
from engine import InvalidImage, Prediction
from storage import ObjectNotFound, StorageError
from worker import InferenceWorker, MalformedJob, parse_job, user_message

# ---------------------------------------------------------------------------
# parse_job
# ---------------------------------------------------------------------------


def test_parses_a_well_formed_message() -> None:
    body = json.dumps(
        {"requestId": "abc", "imageKey": "uploads/abc.png", "contentType": "image/png"}
    ).encode()
    assert parse_job(body) == ("abc", "uploads/abc.png")


@pytest.mark.parametrize(
    ("label", "body"),
    [
        ("not json", b"{not json"),
        ("a json array", b'["a"]'),
        ("a bare string", b'"hello"'),
        ("missing requestId", b'{"imageKey":"k"}'),
        ("missing imageKey", b'{"requestId":"r"}'),
        ("an empty requestId", b'{"requestId":"","imageKey":"k"}'),
        ("a non-string imageKey", b'{"requestId":"r","imageKey":42}'),
    ],
)
def test_rejects_unusable_messages(label: str, body: bytes) -> None:
    with pytest.raises(MalformedJob):
        parse_job(body)


# ---------------------------------------------------------------------------
# Exception hierarchy
# ---------------------------------------------------------------------------


def test_object_not_found_is_a_storage_error() -> None:
    """The except-clause ordering in _on_message depends on this.

    ObjectNotFound must be caught by the permanent clause, which only works
    because that clause precedes the one catching StorageError. If this
    subclassing ever changed, a missing object would silently start being
    retried as though the store were merely unreachable.
    """
    assert issubclass(ObjectNotFound, StorageError)


def test_request_not_found_is_not_a_database_error() -> None:
    """A missing row is permanent; an unreachable database is not."""
    assert not issubclass(RequestNotFound, DatabaseError)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def test_missing_environment_variables_are_all_reported_at_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in ("RABBITMQ_URL", "DATABASE_URL", "S3_ENDPOINT"):
        monkeypatch.delenv(name, raising=False)

    with pytest.raises(RuntimeError) as caught:
        config.load_settings()

    message = str(caught.value)
    # One restart should be enough to learn about every gap, not one per gap.
    assert "RABBITMQ_URL" in message
    assert "DATABASE_URL" in message
    assert "S3_ENDPOINT" in message


def test_user_messages_carry_no_internal_detail() -> None:
    """What the browser is shown must read as a sentence, not a repr."""
    rendered = user_message(InvalidImage("cannot identify <_io.BytesIO object at 0x7f>"))
    assert "0x" not in rendered
    assert "BytesIO" not in rendered
    assert rendered.endswith(".")


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

SETTINGS = Settings(
    rabbit_url="amqp://guest:guest@localhost:5672",
    queue="inference.jobs",
    dead_letter_exchange="inference.dlx",
    dead_letter_queue="inference.jobs.failed",
    database_url="postgresql://localhost/nowhere",
    s3_endpoint="http://localhost:4566",
    s3_bucket="bucket",
    aws_region="us-east-1",
    aws_access_key_id="test",
    aws_secret_access_key="test",
    model_path="./rps_model.pt",
    prefetch=1,
    torch_threads=0,
)

BODY = json.dumps({"requestId": "r-1", "imageKey": "uploads/r-1.png"}).encode()


@dataclass
class FakeMethod:
    delivery_tag: int = 1
    redelivered: bool = False


@dataclass
class FakeChannel:
    """Records what the worker told the broker to do with the message."""

    calls: list[tuple[Any, ...]] = field(default_factory=list)

    def basic_ack(self, delivery_tag: int) -> None:
        self.calls.append(("ack", delivery_tag))

    def basic_nack(self, delivery_tag: int, requeue: bool = False) -> None:
        self.calls.append(("nack", delivery_tag, requeue))


class FakeDatabase:
    def __init__(self, processing_error=None, save_error=None) -> None:
        self.saved: list[str] = []
        self.failed: list[tuple[str, str]] = []
        self._processing_error = processing_error
        self._save_error = save_error

    def mark_processing(self, request_id: str) -> None:
        if self._processing_error:
            raise self._processing_error

    def save_success(self, request_id: str, **_kwargs: Any) -> None:
        if self._save_error:
            raise self._save_error
        self.saved.append(request_id)

    def mark_failed(self, request_id: str, message: str) -> None:
        self.failed.append((request_id, message))


class FakeStorage:
    def __init__(self, error=None) -> None:
        self._error = error

    def download(self, key: str) -> bytes:
        if self._error:
            raise self._error
        return b"image-bytes"


class FakeEngine:
    arch = "resnet18"
    val_acc = 1.0

    def __init__(self, error=None) -> None:
        self._error = error

    def classify_bytes(self, data: bytes) -> Prediction:
        if self._error:
            raise self._error
        return Prediction("rock", 0.99, {"rock": 0.99, "paper": 0.005, "scissors": 0.005}, 51)


def handle(
    *,
    storage_error=None,
    engine_error=None,
    processing_error=None,
    redelivered: bool = False,
    body: bytes = BODY,
) -> tuple[FakeChannel, FakeDatabase]:
    """Run one message through the real callback and report what happened."""
    database = FakeDatabase(processing_error=processing_error)
    worker = InferenceWorker(
        SETTINGS, FakeEngine(engine_error), FakeStorage(storage_error), database
    )
    channel = FakeChannel()
    worker._on_message(channel, FakeMethod(redelivered=redelivered), None, body)
    return channel, database


# ---------------------------------------------------------------------------
# The success path
# ---------------------------------------------------------------------------


def test_a_successful_job_is_saved_and_acknowledged() -> None:
    channel, database = handle()
    assert channel.calls == [("ack", 1)]
    assert database.saved == ["r-1"]
    assert database.failed == []


# ---------------------------------------------------------------------------
# Permanent failures: fail the row, dead-letter the message, never retry
# ---------------------------------------------------------------------------


def test_an_unreadable_message_is_dead_lettered_without_a_retry() -> None:
    """Nothing identifies the job, so there is no row to fail.

    Dead-lettering rather than dropping keeps the bad message available for
    inspection instead of making it vanish.
    """
    channel, database = handle(body=b"{broken")
    assert channel.calls == [("nack", 1, False)]
    assert database.failed == []


@pytest.mark.parametrize(
    ("label", "kwargs"),
    [
        ("an undecodable image", {"engine_error": InvalidImage("truncated")}),
        ("a missing object", {"storage_error": ObjectNotFound("gone")}),
        ("a missing row", {"processing_error": RequestNotFound("no row")}),
    ],
)
def test_permanent_failures_are_not_retried(label: str, kwargs: dict[str, Any]) -> None:
    channel, database = handle(**kwargs)
    assert channel.calls == [("nack", 1, False)], f"{label} should not be requeued"
    assert len(database.failed) == 1, f"{label} should leave a terminal answer for the browser"


# ---------------------------------------------------------------------------
# Transient failures: exactly one retry, counted by AMQP's redelivered flag
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("label", "kwargs"),
    [
        ("the object store", {"storage_error": StorageError("localstack restarting")}),
        ("the database", {"processing_error": DatabaseError("postgres restarting")}),
    ],
)
def test_a_transient_failure_is_requeued_once(label: str, kwargs: dict[str, Any]) -> None:
    channel, database = handle(**kwargs)
    assert channel.calls == [("nack", 1, True)], f"{label} blip should be retried"
    # Not failed yet: the row must not show a terminal error while an attempt
    # is still outstanding.
    assert database.failed == []


def test_a_transient_failure_on_redelivery_gives_up() -> None:
    channel, database = handle(
        storage_error=StorageError("still down"), redelivered=True
    )
    assert channel.calls == [("nack", 1, False)], "the retry must be bounded"
    assert len(database.failed) == 1


# ---------------------------------------------------------------------------
# The catch-all
# ---------------------------------------------------------------------------


def test_an_unexpected_error_does_not_kill_the_consumer() -> None:
    """One bad message must not take down a worker that can serve every other.

    If this exception escaped the callback it would propagate out of
    start_consuming and end the process.
    """
    channel, database = handle(engine_error=RuntimeError("nobody predicted this"))
    assert channel.calls == [("nack", 1, False)]
    assert len(database.failed) == 1


def test_an_unexpected_error_is_not_echoed_to_the_browser() -> None:
    channel, database = handle(
        engine_error=RuntimeError("postgresql://user:hunter2@db:5432 refused")
    )
    _, stored_message = database.failed[0]
    assert "hunter2" not in stored_message
