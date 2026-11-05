import { Router } from 'express';

import type { EmailController } from '../controllers/email.controller.js';

export function createEmailRouter(controller: EmailController): Router {
  const router = Router();
  router.post('/', controller.create);
  router.get('/', controller.list);
  router.get('/:id', controller.getById);
  return router;
}
