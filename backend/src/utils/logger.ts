/**
 * A scoped, single-line logger.
 *
 * Deliberately not a logging library: the requirement is that four containers
 * interleaving output into `docker compose logs` stay readable, and a
 * timestamp plus a scope tag achieves that in thirty lines with no dependency.
 */

type Level = 'info' | 'warn' | 'error';

const STREAM: Record<Level, (line: string) => void> = {
  // Anything below a warning goes to stdout; warnings and errors go to stderr
  // so `docker compose logs` and any collector can split them apart.
  info: (line) => process.stdout.write(`${line}\n`),
  warn: (line) => process.stderr.write(`${line}\n`),
  error: (line) => process.stderr.write(`${line}\n`),
};

function format(level: Level, scope: string, message: string): string {
  return `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    info: (message) => STREAM.info(format('info', scope, message)),
    warn: (message) => STREAM.warn(format('warn', scope, message)),
    error: (message, error) => {
      STREAM.error(format('error', scope, message));
      if (error !== undefined) {
        // Keep the stack on its own lines rather than flattening it into the
        // message, so it stays greppable and readable.
        STREAM.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      }
    },
  };
}

/** Narrow an unknown thrown value to something printable. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
