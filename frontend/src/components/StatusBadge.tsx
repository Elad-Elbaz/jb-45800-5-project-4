import type { InferenceStatus } from '../types/inference';

const LABELS: Record<InferenceStatus, string> = {
  pending: 'Queued',
  processing: 'Running',
  completed: 'Done',
  failed: 'Failed',
};

/**
 * The job's lifecycle state.
 *
 * Colour is not the only signal: each state also has its own word, so the
 * badge still reads correctly in greyscale and to anyone who cannot
 * distinguish the hues.
 */
export function StatusBadge({ status }: { status: InferenceStatus }) {
  return <span className={`badge badge--${status}`}>{LABELS[status]}</span>;
}
