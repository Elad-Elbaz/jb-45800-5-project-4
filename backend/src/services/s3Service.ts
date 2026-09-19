/**
 * Object storage for the uploaded images, backed by LocalStack in Compose.
 *
 * The reason images go to S3 rather than to a shared volume is that the
 * backend and the worker are separate containers with separate filesystems.
 * A bind mount would make them one machine again and quietly undo the
 * decoupling the queue exists to provide; an object store is the thing both
 * can reach and neither owns.
 *
 * Nothing here is LocalStack-specific beyond the endpoint and the credentials.
 * Point S3_ENDPOINT at real AWS and this file is unchanged.
 */

import type { Readable } from 'node:stream';

import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { env } from '../config/env';
import { createLogger, describeError } from '../utils/logger';

const log = createLogger('s3');

export interface StoredObject {
  body: Readable;
  contentLength: number | undefined;
}

export class S3Service {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    this.bucket = env.s3.bucket;
    this.client = new S3Client({
      region: env.s3.region,
      endpoint: env.s3.endpoint,
      credentials: {
        accessKeyId: env.s3.accessKeyId,
        secretAccessKey: env.s3.secretAccessKey,
      },
      /**
       * Virtual-host addressing would resolve `rps-inference.localstack`,
       * which is not a hostname on the Compose network. Path style keeps every
       * request on `http://localstack:4566/rps-inference/...`.
       */
      forcePathStyle: true,
    });
  }

  /**
   * Creates the bucket if it is missing, retrying while LocalStack boots.
   *
   * LocalStack answers TCP well before its S3 provider is ready, so a
   * healthcheck on the port alone is not enough of a gate -- the first
   * HeadBucket can still fail with a connection reset.
   */
  async ensureBucket(attempts = 15, delayMs = 2_000): Promise<void> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
        log.info(`bucket "${this.bucket}" is ready`);
        return;
      } catch (error) {
        if (isMissingBucket(error)) {
          await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
          log.info(`bucket "${this.bucket}" created`);
          return;
        }
        if (attempt === attempts) {
          throw new Error(
            `S3 endpoint ${env.s3.endpoint} unreachable after ${attempts} attempts: ` +
              describeError(error),
          );
        }
        log.warn(`endpoint not ready (attempt ${attempt}/${attempts}), retrying in ${delayMs}ms`);
        await new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
    }
  }

  /** Builds the object key for a request. One key per request id, by construction. */
  buildKey(requestId: string, extension: string): string {
    return `uploads/${requestId}.${extension}`;
  }

  async putImage(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /**
   * Streams an object back out, for the route that serves a thumbnail to the
   * history page.
   *
   * The stream is returned rather than a Buffer so a large image is piped
   * straight to the client instead of being held in the API's heap first.
   */
  async getImage(key: string): Promise<StoredObject> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );

    if (!response.Body) {
      throw new Error(`S3 returned an empty body for "${key}"`);
    }

    // The SDK types Body as a union covering browser and Node runtimes. On
    // Node it is always a Readable, and this service only ever runs on Node.
    return {
      body: response.Body as Readable,
      contentLength: response.ContentLength,
    };
  }

  /** Readiness probe: proves both reachability and that the bucket still exists. */
  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  destroy(): void {
    this.client.destroy();
  }
}

/**
 * Distinguishes "the bucket is not there" from "the service is not there".
 *
 * Worth being careful about: treating an outage as a missing bucket would send
 * a CreateBucket into a broker that is still starting and turn a retryable
 * condition into a hard failure. S3 answers HeadBucket with a bare 404 and no
 * error code, so the status has to be inspected alongside the name.
 */
function isMissingBucket(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    candidate.name === 'NotFound' ||
    candidate.name === 'NoSuchBucket' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}
