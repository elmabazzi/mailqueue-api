import { Router } from 'express';

import type { HealthController } from '../controllers/health.controller.js';

export function createHealthRouter(controller: HealthController): Router {
  const router = Router();
  router.get('/health', controller.check);
  return router;
}
