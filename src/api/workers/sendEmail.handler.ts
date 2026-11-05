import type { Logger } from '../../lib/logger.js';
import { SendEmailJobPayloadSchema, type QueueJob } from '../../models/queue.model.js';
import type { EmailDeliveryService } from '../../services/emailDelivery.service.js';

/** Thrown to tell the queue "this attempt failed, try again later". */
export class RetryLaterError extends Error {
  override readonly name = 'RetryLaterError';
}

export interface JobHandlerDependencies {
  deliveryService: EmailDeliveryService;
  logger: Logger;
}

/**
 * Entry point for queue jobs: the queue's equivalent of a controller.
 * Validates the job payload and hands the work to the delivery service.
 */
export function createSendEmailHandler(deps: JobHandlerDependencies) {
  return async (job: QueueJob): Promise<void> => {
    const payload = SendEmailJobPayloadSchema.safeParse(job.data);
    if (!payload.success) {
      // Retrying a malformed job can never succeed, so drop it.
      deps.logger.error({ queueJobId: job.id }, 'Discarding queue job with an invalid payload');
      return;
    }

    const outcome = await deps.deliveryService.deliver(payload.data.emailJobId, {
      retryCount: job.retryCount,
      retryLimit: job.retryLimit,
    });

    if (outcome === 'retry') {
      throw new RetryLaterError(`Delivery of email job ${payload.data.emailJobId} will be retried`);
    }
  };
}

/** Handles jobs that used up every retry without completing. */
export function createDeadLetterHandler(deps: JobHandlerDependencies) {
  return async (job: QueueJob): Promise<void> => {
    const payload = SendEmailJobPayloadSchema.safeParse(job.data);
    if (!payload.success) {
      deps.logger.error({ queueJobId: job.id }, 'Discarding dead-letter job with invalid payload');
      return;
    }
    await deps.deliveryService.handleExhaustedJob(payload.data.emailJobId);
  };
}
