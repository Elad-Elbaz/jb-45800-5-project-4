/** Small formatters shared by the two pages. */

export function formatPercent(value: number, digits = 2): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
];

/**
 * "12 seconds ago", "3 minutes ago", and so on.
 *
 * Intl.RelativeTimeFormat handles the pluralisation and the wording, which is
 * the part a hand-rolled version gets wrong first.
 */
export function formatRelativeTime(isoTimestamp: string): string {
  const then = new Date(isoTimestamp).getTime();
  if (Number.isNaN(then)) {
    return 'unknown';
  }

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  let delta = Math.round((then - Date.now()) / 1000);

  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(delta) < size) {
      return formatter.format(delta, unit);
    }
    delta = Math.round(delta / size);
  }

  return formatter.format(delta, 'week');
}

/** Capitalised class name, for display only. */
export function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
