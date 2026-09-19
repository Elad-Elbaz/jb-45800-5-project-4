/**
 * Frontend configuration.
 *
 * `API_BASE_URL` defaults to the relative path `/api`, and that default is the
 * one that ships. Vite inlines `import.meta.env` at *build* time, so an
 * environment variable set on the frontend container at run time would have no
 * effect whatsoever -- the JavaScript was already compiled when the image was
 * built. Serving the API under the same origin through nginx sidesteps the
 * problem completely: there is no host name to configure, and no CORS.
 *
 * The override exists for `npm run dev` against an API somewhere unusual.
 */
export const API_BASE_URL: string = import.meta.env.VITE_API_URL ?? '/api';

/**
 * How often to ask whether a job has finished.
 *
 * A forward pass takes roughly 50ms and the queue is usually empty, so most
 * jobs resolve on the first or second poll. Polling faster would mostly add
 * requests that arrive before the worker has been handed the message at all.
 */
export const POLL_INTERVAL_MS = 900;

/** When to stop waiting and tell the user something is wrong. */
export const POLL_TIMEOUT_MS = 120_000;

/**
 * Below this confidence the result is shown as "no confident match".
 *
 * The number comes from the model's measured behaviour, documented in the
 * README: real gestures score 98-100%, while an image that is not a hand at
 * all scored 66%. The model has only three labels and must answer with one of
 * them, so this threshold is the only thing that lets it say "I don't know".
 */
export const CONFIDENCE_THRESHOLD = 0.9;

/** Matches MAX_UPLOAD_BYTES on the server, so the client can refuse early. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Mirrors the formats the backend's magic-number check accepts. */
export const ACCEPTED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp'];
