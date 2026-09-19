import { Router } from 'express';

import type { AppServices } from '../services/container';
import { asyncHandler } from '../utils/asyncHandler';
import { describeError } from '../utils/logger';

interface DependencyCheck {
  name: string;
  ok: boolean;
  error?: string;
}

/**
 * Liveness and readiness, kept distinct because they answer different
 * questions and Compose uses them differently.
 *
 * `/health` asks "is this process alive?" and must not touch a dependency:
 * Compose restarts a container that fails its healthcheck, and a liveness
 * probe wired to Postgres would restart a perfectly healthy backend every time
 * the database hiccupped -- removing the one component able to report the
 * problem.
 *
 * `/health/ready` asks "can this process actually serve traffic?" and does
 * check all three dependencies. It is for humans and for orchestration, not
 * for the restart policy.
 */
export function createHealthRouter(services: AppServices): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });

  router.get(
    '/ready',
    asyncHandler(async (_req, res) => {
      // In parallel: three sequential probes would make the timeout of a slow
      // dependency additive with the others.
      const checks = await Promise.all([
        probe('database', () => services.db.ping()),
        probe('queue', () => services.queue.ping()),
        probe('storage', () => services.s3.ping()),
      ]);

      const ready = checks.every((check) => check.ok);
      res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'degraded',
        checks,
      });
    }),
  );

  return router;
}

async function probe(name: string, check: () => Promise<unknown>): Promise<DependencyCheck> {
  try {
    await check();
    return { name, ok: true };
  } catch (error) {
    // A failing dependency is the answer this endpoint exists to give, so it
    // is reported rather than thrown.
    return { name, ok: false, error: describeError(error) };
  }
}
