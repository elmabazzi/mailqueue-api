/**
 * Worker process entry point (Render "Background Worker").
 * Takes email jobs off the queue and sends them through Resend.
 */
import { config as loadDotenv } from 'dotenv';

import {
  createDeadLetterHandler,
  createSendEmailHandler,
} from './api/workers/sendEmail.handler.js';
import { ConfigError, parseWorkerConfig } from './config/env.js';
import { createDbPool } from './data/db.js';
import { ResendEmailProvider } from './data/providers/resend.provider.js';
import { createQueueClient, PgBossEmailQueue } from './data/queue/emailQueue.js';
import { PgEmailJobRepository } from './data/repositories/emailJob.repository.js';
import { createLogger } from './lib/logger.js';
import { exitOnFatalErrors, onShutdown } from './lib/shutdown.js';
import { EmailDeliveryService } from './services/emailDelivery.service.js';

loadDotenv({ quiet: true });

async function main(): Promise<void> {
  const config = parseWorkerConfig(process.env);
  const logger = createLogger({ name: 'mailqueue-worker', level: config.LOG_LEVEL });
  exitOnFatalErrors(logger);

  const pool = createDbPool(
    {
      connectionString: config.DATABASE_URL,
      ssl: config.DATABASE_SSL,
      max: Math.max(2, config.WORKER_CONCURRENCY + 1),
      applicationName: 'mailqueue-worker',
    },
    (error) => logger.error({ err: error }, 'PostgreSQL pool error'),
  );

  const queue = new PgBossEmailQueue(
    createQueueClient({
      connectionString: config.DATABASE_URL,
      ssl: config.DATABASE_SSL,
      role: 'worker',
      onError: (error) => logger.error({ err: error }, 'Queue error'),
    }),
    { retryLimit: config.EMAIL_MAX_RETRIES, retryDelaySeconds: config.EMAIL_RETRY_DELAY_SECONDS },
  );
  await queue.start();

  const deliveryService = new EmailDeliveryService({
    repository: new PgEmailJobRepository(pool),
    provider: new ResendEmailProvider({ apiKey: config.RESEND_API_KEY, from: config.EMAIL_FROM }),
    logger,
  });

  await queue.consume(
    {
      onSendEmail: createSendEmailHandler({ deliveryService, logger }),
      onDeadLetter: createDeadLetterHandler({ deliveryService, logger }),
    },
    config.WORKER_CONCURRENCY,
  );
  logger.info(
    {
      concurrency: config.WORKER_CONCURRENCY,
      maxRetries: config.EMAIL_MAX_RETRIES,
      retryDelaySeconds: config.EMAIL_RETRY_DELAY_SECONDS,
    },
    'MailQueue worker started',
  );

  onShutdown(logger, async () => {
    await queue.stop(); // waits for in-progress jobs to finish
    await pool.end();
  });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error('Failed to start the worker:', error);
  }
  process.exit(1);
});
