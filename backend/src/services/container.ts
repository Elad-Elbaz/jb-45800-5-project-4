import type { DatabaseService } from './databaseService';
import type { QueueService } from './queueService';
import type { S3Service } from './s3Service';

/**
 * The three collaborators the HTTP layer needs.
 *
 * They are constructed once in server.ts and passed down, rather than being
 * module-level singletons each file imports for itself. The difference shows
 * up at the edges: startup order becomes explicit and reviewable, shutdown has
 * one owner to close them, and a route can be exercised against a stub without
 * the module registry having to be tampered with.
 *
 * Its own file purely to keep app.ts and routes/* from importing each other.
 */
export interface AppServices {
  db: DatabaseService;
  queue: QueueService;
  s3: S3Service;
}
