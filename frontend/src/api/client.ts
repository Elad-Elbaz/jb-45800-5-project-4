/**
 * Every call the app makes to the backend.
 *
 * Built on `fetch` rather than a HTTP library: the app makes four requests,
 * one of which is a plain form upload, and a wrapper this small is less code
 * than the adapter configuration a library would need. What matters is that
 * failures arrive as one predictable type, which is what ApiError provides.
 */

import { API_BASE_URL } from '../config';
import type { InferenceJob, InferenceList, UploadAccepted, ApiErrorBody } from '../types/inference';

export class ApiError extends Error {
  /** HTTP status, or 0 when the request never reached the server. */
  readonly status: number;
  /** The backend's machine-readable tag, e.g. 'unsupported_media_type'. */
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = 'http_error';
  let message = `The server responded with ${response.status}.`;

  try {
    const body = (await response.json()) as Partial<ApiErrorBody>;
    if (typeof body.message === 'string' && body.message) {
      message = body.message;
    }
    if (typeof body.error === 'string' && body.error) {
      code = body.error;
    }
  } catch {
    // Not every error response comes from our code: nginx answers a 502 with
    // HTML when the backend is down. The status-based default above is the
    // right message in that case.
  }

  return new ApiError(response.status, code, message);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE_URL}${path}`, init);
  } catch (cause) {
    // An aborted request is a deliberate cancellation -- a component
    // unmounting, usually -- and must not be reported to the user as a
    // failure, so it is rethrown unchanged for the caller to recognise.
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      throw cause;
    }
    throw new ApiError(0, 'network_error', 'Could not reach the server. Is it running?');
  }

  if (!response.ok) {
    throw await toApiError(response);
  }

  return (await response.json()) as T;
}

export function uploadImage(file: File, signal?: AbortSignal): Promise<UploadAccepted> {
  const form = new FormData();
  // The field name the backend's multer instance expects.
  form.append('image', file);

  return request<UploadAccepted>('/inference', {
    method: 'POST',
    body: form,
    /**
     * Note the absence of a Content-Type header. Setting it by hand is the
     * classic way to break a multipart upload: the browser generates a
     * boundary token and puts it in the header it writes, and a hand-written
     * `multipart/form-data` overwrites that, leaving the server unable to find
     * where the parts begin.
     */
    signal,
  });
}

export function getInference(requestId: string, signal?: AbortSignal): Promise<InferenceJob> {
  return request<InferenceJob>(`/inference/${requestId}`, { signal });
}

export function listInferences(limit: number, signal?: AbortSignal): Promise<InferenceList> {
  return request<InferenceList>(`/inference?limit=${limit}`, { signal });
}

/** URL of the stored image, served by the API rather than straight from S3. */
export function inferenceImageUrl(requestId: string): string {
  return `${API_BASE_URL}/inference/${requestId}/image`;
}
