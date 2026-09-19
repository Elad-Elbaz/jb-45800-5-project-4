import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, uploadImage } from '../api/client';
import { ImagePicker } from '../components/ImagePicker';
import { PredictionResult } from '../components/PredictionResult';
import { StatusBadge } from '../components/StatusBadge';
import { useInferenceJob } from '../hooks/useInferenceJob';

const PROGRESS_COPY: Record<string, string> = {
  pending: 'Waiting for a worker to pick the job up.',
  processing: 'The model is running.',
};

export function ClassifyPage() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{ source: File; url: string } | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const { job, error: pollError, isPolling } = useInferenceJob(requestId);

  /**
   * Object URLs are not garbage collected: the browser holds the blob alive
   * until the URL is explicitly revoked. Without this cleanup, picking twenty
   * images in a row would keep all twenty in memory for the life of the tab.
   *
   * This is the case an effect is actually for -- allocating and releasing a
   * resource that lives outside React -- so the URL is created here and the
   * cleanup revokes it when the file changes or the page unmounts.
   *
   * Creating it in the change handler instead would silence the lint warning
   * below and break the preview in development: StrictMode mounts, unmounts
   * and remounts, the unmount revokes the URL, and nothing would recreate it.
   * Allocating inside the effect body is what makes the remount recover.
   */
  useEffect(() => {
    if (!file) {
      return;
    }
    const url = URL.createObjectURL(file);
    // This hits the rule's own stated exception -- synchronising with an
    // external system -- which the linter cannot detect on its own.
    // oxlint-disable-next-line react/set-state-in-effect
    setPreview({ source: file, url });
    return () => URL.revokeObjectURL(url);
  }, [file]);

  /**
   * Derived rather than cleared from the effect above: any URL belonging to a
   * different file has already been revoked by that effect's cleanup, so
   * rendering it would show a broken image.
   */
  const previewUrl = file !== null && preview?.source === file ? preview.url : null;

  const busy = isUploading || isPolling;

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!file || busy) {
      return;
    }

    setIsUploading(true);
    setUploadError(null);
    // Clearing the previous id also resets the polling hook, so a second
    // submission cannot briefly display the first result.
    setRequestId(null);

    try {
      const accepted = await uploadImage(file);
      setRequestId(accepted.requestId);
    } catch (cause) {
      setUploadError(cause instanceof ApiError ? cause.message : 'The upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleReset = (): void => {
    setFile(null);
    setRequestId(null);
    setUploadError(null);
  };

  const failureMessage =
    job?.status === 'failed' ? (job.errorMessage ?? 'Inference failed on the worker.') : null;
  const error = uploadError ?? pollError ?? failureMessage;

  return (
    <div className="stack">
      <section className="panel">
        <h1 className="page-title">Classify a hand gesture</h1>
        <p className="page-subtitle">
          Upload a photo of a hand playing rock, paper or scissors. The image is stored,
          queued, and classified by a ResNet18 running in a separate worker.
        </p>

        <form onSubmit={handleSubmit} className="stack">
          <ImagePicker
            previewUrl={previewUrl}
            fileName={file?.name ?? null}
            disabled={busy}
            onSelect={(next) => {
              setFile(next);
              setRequestId(null);
              setUploadError(null);
            }}
            onReject={setUploadError}
          />

          <div className="actions">
            <button type="submit" className="button button--primary" disabled={!file || busy}>
              {isUploading ? 'Uploading…' : isPolling ? 'Classifying…' : 'Classify'}
            </button>
            <button
              type="button"
              className="button"
              onClick={handleReset}
              disabled={busy || (!file && !requestId)}
            >
              Reset
            </button>
          </div>
        </form>
      </section>

      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}

      {isPolling && (
        <section className="panel panel--status" aria-live="polite">
          <div className="status-line">
            <span className="spinner" aria-hidden="true" />
            <StatusBadge status={job?.status ?? 'pending'} />
            <span>{PROGRESS_COPY[job?.status ?? 'pending'] ?? 'Working…'}</span>
          </div>
          <p className="muted">
            The browser is polling for a result; the request was accepted the moment it was
            queued, so nothing is blocked while the model runs.
          </p>
        </section>
      )}

      {job?.status === 'completed' && job.prediction && (
        <div className="panel">
          <PredictionResult prediction={job.prediction} />
        </div>
      )}
    </div>
  );
}
