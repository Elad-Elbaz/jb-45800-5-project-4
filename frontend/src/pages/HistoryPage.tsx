import { useCallback, useEffect, useState } from 'react';

import { ApiError, inferenceImageUrl, listInferences } from '../api/client';
import { StatusBadge } from '../components/StatusBadge';
import { CONFIDENCE_THRESHOLD } from '../config';
import type { InferenceJob } from '../types/inference';
import { isTerminal } from '../types/inference';
import { formatPercent, formatRelativeTime, titleCase } from '../utils/format';

const HISTORY_LIMIT = 24;
const REFRESH_MS = 2_000;

/**
 * Recent predictions, read back out of Postgres.
 *
 * This page is the visible argument for the database half of the
 * architecture: the queue has long since discarded these messages, and every
 * row here survives a restart of every other service.
 */
export function HistoryPage() {
  const [items, setItems] = useState<InferenceJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    listInferences(HISTORY_LIMIT, controller.signal)
      .then((response) => {
        if (!cancelled) {
          setItems(response.items);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (cancelled || controller.signal.aborted) {
          return;
        }
        setError(cause instanceof ApiError ? cause.message : 'Could not load the history.');
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [reloadToken]);

  /**
   * Refresh only while something is still running, and stop once everything
   * has settled. A timer that ran forever would keep an idle tab talking to
   * the server about a list that cannot change.
   */
  const hasUnfinished = items?.some((item) => !isTerminal(item.status)) ?? false;
  useEffect(() => {
    if (!hasUnfinished) {
      return;
    }
    const timer = window.setTimeout(reload, REFRESH_MS);
    return () => window.clearTimeout(timer);
  }, [hasUnfinished, reloadToken, reload]);

  return (
    <div className="stack">
      <section className="panel">
        <div className="history__header">
          <div>
            <h1 className="page-title">Recent predictions</h1>
            <p className="page-subtitle">
              Everything the pipeline has processed, newest first, read from Postgres.
            </p>
          </div>
          <button type="button" className="button" onClick={reload}>
            Refresh
          </button>
        </div>
      </section>

      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}

      {items === null && !error && <p className="muted">Loading…</p>}

      {items !== null && items.length === 0 && (
        <p className="notice">Nothing here yet. Classify an image and it will show up.</p>
      )}

      {items !== null && items.length > 0 && (
        <ul className="history">
          {items.map((item) => (
            <li key={item.requestId} className="history__card">
              <div className="history__thumb">
                <img
                  src={inferenceImageUrl(item.requestId)}
                  alt={item.originalName}
                  loading="lazy"
                  /**
                   * A row can outlive its image: Postgres persists across a
                   * `docker compose down` and LocalStack's community edition
                   * cannot. Hiding the broken element beats showing the
                   * browser's default torn-image icon.
                   */
                  onError={(event) => {
                    event.currentTarget.style.display = 'none';
                  }}
                />
              </div>

              <div className="history__body">
                <div className="history__top">
                  <StatusBadge status={item.status} />
                  <span className="muted">{formatRelativeTime(item.createdAt)}</span>
                </div>

                {item.prediction ? (
                  <p className="history__verdict">
                    {item.prediction.confidence >= CONFIDENCE_THRESHOLD ? (
                      <>
                        <strong>{titleCase(item.prediction.predictedClass)}</strong>{' '}
                        <span className="muted">
                          {formatPercent(item.prediction.confidence)}
                        </span>
                      </>
                    ) : (
                      <span className="history__unsure">
                        No confident match
                        <span className="muted">
                          {' '}
                          ({titleCase(item.prediction.predictedClass)},{' '}
                          {formatPercent(item.prediction.confidence)})
                        </span>
                      </span>
                    )}
                  </p>
                ) : (
                  <p className="history__verdict muted">
                    {item.status === 'failed' ? (item.errorMessage ?? 'Failed') : 'Waiting…'}
                  </p>
                )}

                <p className="history__file" title={item.originalName}>
                  {item.originalName}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
