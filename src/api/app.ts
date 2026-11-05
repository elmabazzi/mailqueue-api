import express, { type Express } from 'express';

import type { Logger } from '../lib/logger.js';
import type { EmailService } from '../services/email.service.js';
import type { HealthService } from '../services/health.service.js';
import { EmailController } from './controllers/email.controller.js';
import { HealthController } from './controllers/health.controller.js';
import { requireApiKey } from './middleware/apiKey.js';
import { createErrorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createRequestLogger } from './middleware/requestLogger.js';
import { createEmailRouter } from './routes/email.routes.js';
import { createHealthRouter } from './routes/health.routes.js';

export interface AppDependencies {
  emailService: EmailService;
  healthService: HealthService;
  logger: Logger;
  apiKey?: string | undefined;
}

/** Builds the Express app. Does not listen on a port, so tests can use it directly. */
export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render runs the app behind one proxy

  app.use(createRequestLogger(deps.logger));
  app.use(express.json({ limit: '256kb' }));

  app.use(createHealthRouter(new HealthController(deps.healthService)));
  app.use(
    '/emails',
    requireApiKey(deps.apiKey),
    createEmailRouter(new EmailController(deps.emailService)),
  );

  app.use(notFoundHandler);
  app.use(createErrorHandler(deps.logger));
  return app;
}
