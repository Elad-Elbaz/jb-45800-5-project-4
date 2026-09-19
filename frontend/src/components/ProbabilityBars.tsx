import { formatPercent, titleCase } from '../utils/format';

interface ProbabilityBarsProps {
  probabilities: Record<string, number>;
  /** The winning class, highlighted among the rest. */
  winner: string;
}

/**
 * The full softmax distribution, not just the winner.
 *
 * Showing all three is what lets someone see *how* confident the model is:
 * a 99/0.5/0.5 split and a 40/35/25 split both report the same top class, and
 * only one of them is worth believing.
 */
export function ProbabilityBars({ probabilities, winner }: ProbabilityBarsProps) {
  const ranked = Object.entries(probabilities).sort(([, a], [, b]) => b - a);

  return (
    <ul className="bars">
      {ranked.map(([className, probability]) => (
        <li key={className} className="bars__row">
          <span className="bars__label">{titleCase(className)}</span>
          <div
            className="bars__track"
            // The bar is decorative; the text alternative carries the value so
            // a screen reader is not left describing an empty div.
            role="img"
            aria-label={`${titleCase(className)}: ${formatPercent(probability)}`}
          >
            <div
              className={`bars__fill${className === winner ? ' bars__fill--winner' : ''}`}
              style={{ width: `${Math.max(probability * 100, 0.5)}%` }}
            />
          </div>
          <span className="bars__value">{formatPercent(probability)}</span>
        </li>
      ))}
    </ul>
  );
}
