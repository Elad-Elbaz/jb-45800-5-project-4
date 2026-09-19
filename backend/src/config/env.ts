/**
 * Typed, validated access to the process environment.
 *
 * Everything the backend reads from the environment is resolved once, here, at
 * import time. The rest of the codebase imports `env` and gets a plain typed
 * object -- no `process.env.FOO!` sprinkled across modules, and no service
 * discovering at 3am that a variable it needed was never set.
 *
 * Missing variables are collected and reported together rather than one per
 * restart, so a fresh deployment learns about all of its gaps in one pass.
 */

import dotenv from 'dotenv';

// Loads .env when running outside Docker. Inside Compose the variables are
// already in the environment and this call is a harmless no-op.
dotenv.config();

const missing: string[] = [];
const invalid: string[] = [];

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    missing.push(name);
    return '';
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    invalid.push(`${name} must be a positive integer (got "${raw}")`);
    return fallback;
  }
  return parsed;
}

export const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  port: integer('PORT', 5000),

  databaseUrl: required('DATABASE_URL'),

  rabbit: {
    url: required('RABBITMQ_URL'),
    /**
     * Queue and exchange names are configuration rather than constants because
     * the Python worker has to agree with them exactly. Compose sets the same
     * three values on both services; see inference/config.py.
     */
    queue: optional('RABBITMQ_QUEUE', 'inference.jobs'),
    deadLetterExchange: optional('RABBITMQ_DLX', 'inference.dlx'),
    deadLetterQueue: optional('RABBITMQ_DLQ', 'inference.jobs.failed'),
  },

  s3: {
    /**
     * Points at LocalStack in Compose. Left unset it would fall back to real
     * AWS, which is exactly the accident this project must not have, so it is
     * required rather than defaulted.
     */
    endpoint: required('S3_ENDPOINT'),
    region: optional('AWS_REGION', 'us-east-1'),
    bucket: optional('S3_BUCKET', 'rps-inference'),
    accessKeyId: optional('AWS_ACCESS_KEY_ID', 'test'),
    secretAccessKey: optional('AWS_SECRET_ACCESS_KEY', 'test'),
  },

  /** Hard ceiling enforced by multer before a byte reaches memory. */
  maxUploadBytes: integer('MAX_UPLOAD_BYTES', 10 * 1024 * 1024),

  /**
   * In Compose the browser talks to nginx, which proxies /api on the same
   * origin, so CORS is never exercised. It matters only for `npm run dev`,
   * where Vite serves on :5173 and the API on :5000.
   */
  corsOrigin: optional('CORS_ORIGIN', '*'),
} as const;

export const isProduction = env.nodeEnv === 'production';

if (missing.length > 0 || invalid.length > 0) {
  const problems = [
    ...missing.map((name) => `  - ${name} is required but was not set`),
    ...invalid.map((message) => `  - ${message}`),
  ].join('\n');

  // Throwing here kills the process before the HTTP listener opens, so an
  // under-configured container fails immediately and visibly instead of
  // accepting traffic it cannot serve.
  throw new Error(`Invalid environment configuration:\n${problems}\n`);
}
