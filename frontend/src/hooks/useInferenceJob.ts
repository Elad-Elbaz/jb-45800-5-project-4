/**
 * Polls one inference job until it reaches a terminal state.
 *
 * Polling is what makes the asynchronous backend usable from a browser
 * without websockets: the upload returns a request id immediately, and this
 * hook turns that id into a live view of the job.
 */

import { useEffect, useState } from 'react';

import { ApiError, getInference } from '../api/client';
import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from '../config';
import type { InferenceJob } from '../types/inference';
import { isTerminal } from '../types/inference';

export interface InferenceJobState {
  job: InferenceJob | null;
  error: string | null;
  isPolling: boolean;
}

/**
 * What the last response told us, and which request it was about.
 *
 * Carrying the id inside the state is what lets the hook answer correctly on
 * the very first render after `requestId` changes, before any request for the
 * new id has come back. The alternative -- clearing the old values from inside
 * the effect -- would render the previous job's result once against the new
 * id, and cost an extra render to undo.
 */
interface PollState {
  requestId: string | null;
  job: InferenceJob | null;
  error: string | null;
  /** True once polling has stopped, for any reason. */
  settled: boolean;
}

const IDLE: PollState = { requestId: null, job: null, error: null, settled: true };

const TIMEOUT_MESSAGE =
  'The prediction is taking longer than expected. It may still finish — check the history page.';

export function useInferenceJob(requestId: string | null): InferenceJobState {
  const [state, setState] = useState<PollState>(IDLE);

  useEffect(() => {
    if (!requestId) {
      return;
    }

    /**
     * Guards against a response that lands after this effect has been torn
     * down. React runs effects twice in development StrictMode precisely to
     * surface the bug this prevents: without it, the discarded run's in-flight
     * request would still call setState.
     */
    let cancelled = false;
    let timer: number | undefined;
    const controller = new AbortController();
    const startedAt = Date.now();

    const poll = async (): Promise<void> => {
      try {
        const job = await getInference(requestId, controller.signal);
        if (cancelled) {
          return;
        }

        if (isTerminal(job.status)) {
          setState({ requestId, job, error: null, settled: true });
          return;
        }

        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
          setState({ requestId, job, error: TIMEOUT_MESSAGE, settled: true });
          return;
        }

        setState({ requestId, job, error: null, settled: false });

        /**
         * setTimeout after each response, rather than setInterval. An interval
         * fires on a fixed schedule whether or not the previous request has
         * returned, so a slow backend would accumulate overlapping requests
         * and make itself slower still. Scheduling the next poll only once the
         * last has landed keeps exactly one request in flight.
         */
        timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
      } catch (cause) {
        if (cancelled || controller.signal.aborted) {
          return;
        }
        setState({
          requestId,
          job: null,
          error: cause instanceof ApiError ? cause.message : 'Lost contact with the server.',
          settled: true,
        });
      }
    };

    void poll();

    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [requestId]);

  // Derived during render rather than assigned from the effect. While the
  // stored state still describes a previous request, this one has no result
  // yet and is by definition still in flight.
  const describesCurrentRequest = state.requestId === requestId;

  return {
    job: describesCurrentRequest ? state.job : null,
    error: describesCurrentRequest ? state.error : null,
    isPolling: requestId !== null && (!describesCurrentRequest || !state.settled),
  };
}
