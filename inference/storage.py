"""Reads uploaded images back out of S3 (LocalStack in Compose).

The worker only ever downloads. The backend is the sole writer to the bucket,
which keeps the ownership of every object unambiguous: one writer, one key
format, no coordination needed between containers that never talk directly.
"""

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from config import Settings


class StorageError(Exception):
    """The object store could not be reached or refused the request.

    Treated as *transient* by the worker: the bucket is presumed fine and the
    job is worth one more attempt.
    """


class ObjectNotFound(StorageError):
    """The key does not exist.

    Treated as *permanent*. Retrying cannot conjure an object, and the only
    ways to get here -- a bucket emptied underneath a queued job, or a message
    that outlived its data -- are not fixed by waiting.
    """


class ObjectStorage:
    def __init__(self, settings: Settings) -> None:
        self._bucket = settings.s3_bucket
        self._client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint,
            region_name=settings.aws_region,
            aws_access_key_id=settings.aws_access_key_id,
            aws_secret_access_key=settings.aws_secret_access_key,
            config=Config(
                # Path addressing, for the same reason as the backend: the
                # virtual-host form would resolve "rps-inference.localstack",
                # which is not a host on the Compose network.
                s3={"addressing_style": "path"},
                retries={"max_attempts": 3, "mode": "standard"},
                connect_timeout=5,
                read_timeout=30,
            ),
        )

    def download(self, key: str) -> bytes:
        """Fetch an object whole.

        Read into memory rather than streamed because the next thing that
        happens to these bytes is PIL decoding them into a full-resolution
        bitmap, which is already far larger than the encoded file. Streaming
        would add machinery and save nothing.
        """
        try:
            response = self._client.get_object(Bucket=self._bucket, Key=key)
            return response["Body"].read()
        except ClientError as error:
            code = error.response.get("Error", {}).get("Code", "")
            if code in {"NoSuchKey", "404", "NoSuchBucket"}:
                raise ObjectNotFound(f"s3://{self._bucket}/{key} does not exist") from error
            raise StorageError(f"S3 refused GET {key}: {error}") from error
        except BotoCoreError as error:
            # Connection-level trouble: DNS, timeouts, a LocalStack restart.
            raise StorageError(f"S3 unreachable while fetching {key}: {error}") from error

    def ping(self) -> None:
        """Prove at startup that the bucket exists and is reachable."""
        try:
            self._client.head_bucket(Bucket=self._bucket)
        except (ClientError, BotoCoreError) as error:
            raise StorageError(f"bucket {self._bucket!r} is not reachable: {error}") from error
