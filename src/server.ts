/**
 * API process entry point (Render "Web Service").
 * Composition root: creates every layer's objects and connects them.
 */
import { config as loadDotenv } from 'dotenv';

import { createApp } from './api/app.js';
import { readPackageInfo } from './config/appInfo.js';
import { ConfigError, parseApiConfig } from './config/env.js';
import { createDbPool } from './data/db.js';
import { createQueueClient, PgBossEmailQueue } from './data/queue/emailQueue.js';
import { PgEmailJobRepository } from './data/repositories/emailJob.repository.js';
import { PgHealthRepository } from './data/repositories/health.repository.js';
import { PgTransactionRunner } from './data/transaction.js';
import { createLogger } from './lib/logger.js';
import { exitOnFatalErrors, onShutdown } from './lib/shutdown.js';
import { EmailService } from './services/email.service.js';
import { HealthService } from './services/health.service.js';
import { startEmailWorker } from './startEmailWorker.js';

loadDotenv({ quiet: true });

async function main(): Promise<void> {
  const config = parseApiConfig(process.env);
  const pkg = readPackageInfo();
  const logger = createLogger({ name: 'mailqueue-api', level: config.LOG_LEVEL });
  exitOnFatalErrors(logger);

  const embeddedWorker = config.RUN_WORKER_IN_API;

  const pool = createDbPool(
    {
      connectionString: config.DATABASE_URL,
      ssl: config.DATABASE_SSL,
      // The embedded worker needs extra connections for the emails it sends in parallel.
      max: config.DATABASE_POOL_MAX + (embeddedWorker ? config.WORKER_CONCURRENCY : 0),
      applicationName: 'mailqueue-api',
    },
    (error) => logger.error({ err: error }, 'PostgreSQL pool error'),
  );

  const queue = new PgBossEmailQueue(
    createQueueClient({
      connectionString: config.DATABASE_URL,
      ssl: config.DATABASE_SSL,
      role: embeddedWorker ? 'worker' : 'producer',
      onError: (error) => logger.error({ err: error }, 'Queue error'),
    }),
    { retryLimit: config.EMAIL_MAX_RETRIES, retryDelaySeconds: config.EMAIL_RETRY_DELAY_SECONDS },
  );
  await queue.start();

  const emailService = new EmailService({
    repository: new PgEmailJobRepository(pool),
    queue,
    transactions: new PgTransactionRunner(pool),
    logger,
  });
  const healthService = new HealthService({
    repository: new PgHealthRepository(pool),
    appInfo: { name: pkg.name, version: pkg.version, environment: config.NODE_ENV },
    logger,
  });

  if (!config.API_KEY) {
    logger.warn('API_KEY is not set: /emails endpoints are open (allowed outside production only)');
  }

  if (embeddedWorker && config.RESEND_API_KEY && config.EMAIL_FROM) {
    await startEmailWorker({
      pool,
      queue,
      logger,
      resendApiKey: config.RESEND_API_KEY,
      emailFrom: config.EMAIL_FROM,
      concurrency: config.WORKER_CONCURRENCY,
    });
    logger.info(
      { concurrency: config.WORKER_CONCURRENCY, maxRetries: config.EMAIL_MAX_RETRIES },
      'Email worker running inside the API process (RUN_WORKER_IN_API=true)',
    );
  }

  const app = createApp({ emailService, healthService, logger, apiKey: config.API_KEY });
  const server = app.listen(config.PORT, '0.0.0.0', () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'MailQueue API listening');
  });

  onShutdown(logger, async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await queue.stop(); // with the embedded worker, also waits for in-progress emails
    await pool.end();
  });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error('Failed to start the API:', error);
  }
  process.exit(1);
});
