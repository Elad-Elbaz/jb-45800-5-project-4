/**
 * The API contract, mirrored from backend/src/models/types.ts.
 *
 * Duplicated rather than shared through a workspace package: the two sides
 * build in different containers with different tsconfigs, and a shared package
 * would couple the frontend's build to the backend's. The cost of duplication
 * is that these must be changed together, which is why they say so.
 */

export type InferenceStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface Prediction {
  predictedClass: string;
  /** Softmax probability of the winning class, in [0, 1]. */
  confidence: number;
  /** The full distribution across every class the model knows. */
  probabilities: Record<string, number>;
  modelArch: string;
  modelValAcc: number | null;
  durationMs: number;
}

export interface InferenceJob {
  requestId: string;
  status: InferenceStatus;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  /** Non-null only once `status` is 'completed'. */
  prediction: Prediction | null;
}

export interface UploadAccepted {
  requestId: string;
  status: 'pending';
  statusUrl: string;
}

export interface InferenceList {
  items: InferenceJob[];
}

export interface ApiErrorBody {
  error: string;
  message: string;
}

/** True once the job has reached a state that will never change again. */
export function isTerminal(status: InferenceStatus): boolean {
  return status === 'completed' || status === 'failed';
}
