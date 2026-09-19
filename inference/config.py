"""Environment configuration for the inference worker.

Mirrors backend/src/config/env.ts on purpose, including the habit of
collecting every missing variable and reporting them together: a worker that
is short two settings should say so once, not across two restarts.

The queue, exchange and dead-letter names are read from the environment rather
than hardcoded because the backend declares the same topology from the same
values. RabbitMQ rejects a redeclaration whose arguments differ, so the two
services agreeing here is a runtime requirement and not a matter of taste.
"""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    """Every value the worker reads from its environment."""

    rabbit_url: str
    queue: str
    dead_letter_exchange: str
    dead_letter_queue: str

    database_url: str

    s3_endpoint: str
    s3_bucket: str
    aws_region: str
    aws_access_key_id: str
    aws_secret_access_key: str

    model_path: str

    # How many messages the broker may hand this worker before it acknowledges
    # one. See the note in worker.py for why the answer is 1.
    prefetch: int

    # Caps the intra-op thread pool PyTorch would otherwise size to every core
    # on the host. Left at 0 the framework's own default applies.
    torch_threads: int


def load_settings() -> Settings:
    """Read and validate the environment, or raise with everything that is wrong."""
    missing: list[str] = []

    def required(name: str) -> str:
        value = os.environ.get(name, "").strip()
        if not value:
            missing.append(name)
        return value

    def optional(name: str, fallback: str) -> str:
        return os.environ.get(name, "").strip() or fallback

    def integer(name: str, fallback: int) -> int:
        raw = os.environ.get(name, "").strip()
        if not raw:
            return fallback
        try:
            return int(raw)
        except ValueError:
            missing.append(f"{name} (must be an integer, got {raw!r})")
            return fallback

    settings = Settings(
        rabbit_url=required("RABBITMQ_URL"),
        queue=optional("RABBITMQ_QUEUE", "inference.jobs"),
        dead_letter_exchange=optional("RABBITMQ_DLX", "inference.dlx"),
        dead_letter_queue=optional("RABBITMQ_DLQ", "inference.jobs.failed"),
        database_url=required("DATABASE_URL"),
        s3_endpoint=required("S3_ENDPOINT"),
        s3_bucket=optional("S3_BUCKET", "rps-inference"),
        aws_region=optional("AWS_REGION", "us-east-1"),
        aws_access_key_id=optional("AWS_ACCESS_KEY_ID", "test"),
        aws_secret_access_key=optional("AWS_SECRET_ACCESS_KEY", "test"),
        model_path=optional("MODEL_PATH", "./rps_model.pt"),
        prefetch=integer("WORKER_PREFETCH", 1),
        torch_threads=integer("TORCH_NUM_THREADS", 0),
    )

    if missing:
        listed = "\n".join(f"  - {name}" for name in missing)
        raise RuntimeError(f"Invalid environment configuration:\n{listed}\n")

    return settings


# Must match DEAD_LETTER_ROUTING_KEY in backend/src/services/queueService.ts.
DEAD_LETTER_ROUTING_KEY = "failed"
