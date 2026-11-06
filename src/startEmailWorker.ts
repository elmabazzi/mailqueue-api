/**
 * Wires up and starts the email worker (queue consumer -> delivery service -> Resend).
 *
 * Shared by both ways of running the worker:
 * - src/worker.ts: a separate process (Render "Background Worker")
 * - src/server.ts: inside the API process when RUN_WORKER_IN_API=true (single free Render service)
 */
import {
  createDeadLetterHandler,
  createSendEmailHandler,
} from './api/workers/sendEmail.handler.js';
import type { DbPool } from './data/db.js';
import { ResendEmailProvider } from './data/providers/resend.provider.js';
import type { PgBossEmailQueue } from './data/queue/emailQueue.js';
import { PgEmailJobRepository } from './data/repositories/emailJob.repository.js';
import type { Logger } from './lib/logger.js';
import { EmailDeliveryService } from './services/emailDelivery.service.js';

export interface EmailWorkerOptions {
  pool: DbPool;
  /** Must already be started (queue.start()). */
  queue: PgBossEmailQueue;
  logger: Logger;
  resendApiKey: string;
  emailFrom: string;
  concurrency: number;
}

export async function startEmailWorker(options: EmailWorkerOptions): Promise<void> {
  const { pool, queue, logger } = options;

  const deliveryService = new EmailDeliveryService({
    repository: new PgEmailJobRepository(pool),
    provider: new ResendEmailProvider({ apiKey: options.resendApiKey, from: options.emailFrom }),
    logger,
  });

  await queue.consume(
    {
      onSendEmail: createSendEmailHandler({ deliveryService, logger }),
      onDeadLetter: createDeadLetterHandler({ deliveryService, logger }),
    },
    options.concurrency,
  );
}
