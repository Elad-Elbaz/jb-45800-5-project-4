import { Router } from 'express';

import { InferenceController } from '../controllers/inferenceController';
import { uploadSingleImage } from '../middleware/upload';
import type { AppServices } from '../services/container';

export function createInferenceRouter(services: AppServices): Router {
  const router = Router();
  const controller = new InferenceController(services.db, services.queue, services.s3);

  router.post('/inference', uploadSingleImage, controller.create);
  router.get('/inference', controller.list);

  /**
   * The two-segment route is declared before `/inference/:requestId` reads as
   * though it might shadow it, but it cannot: Express matches on the whole
   * path, and `:requestId` never spans a slash. Ordering here is for reading,
   * not for correctness.
   */
  router.get('/inference/:requestId', controller.findOne);
  router.get('/inference/:requestId/image', controller.findImage);

  return router;
}
