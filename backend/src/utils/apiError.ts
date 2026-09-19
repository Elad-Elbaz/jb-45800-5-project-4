/**
 * An error that already knows which HTTP status it deserves.
 *
 * Controllers throw these instead of writing a response and returning, which
 * keeps every failure path flowing through the one error handler in
 * middleware/errorHandler.ts. That is what makes "never leak a stack trace in
 * production" a property of a single file rather than a rule every controller
 * has to remember.
 */
export class ApiError extends Error {
  readonly status: number;
  /** Short machine-readable tag, e.g. 'not_found'. Stable for clients. */
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    // Without this the stack starts inside the Error constructor rather than
    // at the throw site, because ApiError extends a built-in.
    Error.captureStackTrace?.(this, ApiError);
  }

  static badRequest(message: string): ApiError {
    return new ApiError(400, 'bad_request', message);
  }

  static notFound(message: string): ApiError {
    return new ApiError(404, 'not_found', message);
  }

  static payloadTooLarge(message: string): ApiError {
    return new ApiError(413, 'payload_too_large', message);
  }

  static unsupportedMediaType(message: string): ApiError {
    return new ApiError(415, 'unsupported_media_type', message);
  }

  /** A dependency (broker, storage, database) is unreachable, not the client's fault. */
  static serviceUnavailable(message: string): ApiError {
    return new ApiError(503, 'service_unavailable', message);
  }
}
