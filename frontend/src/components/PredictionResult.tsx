import { CONFIDENCE_THRESHOLD } from '../config';
import type { Prediction } from '../types/inference';
import { formatPercent, titleCase } from '../utils/format';
import { ProbabilityBars } from './ProbabilityBars';

/**
 * The finished prediction.
 *
 * When confidence falls below the threshold this deliberately leads with "No
 * confident match" instead of the winning label. The model has exactly three
 * labels and must answer with one of them, so a photo of a coffee cup still
 * produces a winner -- the README measures that at around 66%, against 98-100%
 * for real gestures. Presenting that as "Rock" would be the interface lying on
 * the model's behalf.
 */
export function PredictionResult({ prediction }: { prediction: Prediction }) {
  const isConfident = prediction.confidence >= CONFIDENCE_THRESHOLD;

  return (
    <section className="result" aria-live="polite">
      <header className="result__header">
        <p className="result__eyebrow">{isConfident ? 'Prediction' : 'Best guess'}</p>
        <h2 className={`result__class${isConfident ? '' : ' result__class--unsure'}`}>
          {isConfident ? titleCase(prediction.predictedClass) : 'No confident match'}
        </h2>
        <p className="result__confidence">
          {isConfident ? (
            <>
              <strong>{formatPercent(prediction.confidence)}</strong> confidence
            </>
          ) : (
            <>
              Closest label is <strong>{titleCase(prediction.predictedClass)}</strong> at{' '}
              {formatPercent(prediction.confidence)}
            </>
          )}
        </p>
      </header>

      {!isConfident && (
        <p className="notice notice--warn">
          Everything below {formatPercent(CONFIDENCE_THRESHOLD, 0)} is reported as uncertain.
          The model only knows rock, paper and scissors, so it has no way to answer
          &ldquo;none of these&rdquo; on its own.
        </p>
      )}

      <ProbabilityBars
        probabilities={prediction.probabilities}
        winner={prediction.predictedClass}
      />

      <footer className="result__meta">
        <span>{prediction.modelArch}</span>
        {prediction.modelValAcc !== null && (
          <span>{formatPercent(prediction.modelValAcc)} validation accuracy</span>
        )}
        <span>{prediction.durationMs} ms</span>
      </footer>
    </section>
  );
}
