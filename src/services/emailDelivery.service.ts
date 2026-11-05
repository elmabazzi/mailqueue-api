import type { EmailProvider } from '../data/providers/resend.provider.js';
import type { EmailJobRepository } from '../data/repositories/emailJob.repository.js';
import type { Logger } from '../lib/logger.js';
import { EmailDeliveryError } from '../models/errors.js';
import type { DeliveryAttempt, DeliveryOutcome } from '../models/queue.model.js';

export interface EmailDeliveryServiceDependencies {
  repository: EmailJobRepository;
  provider: EmailProvider;
  logger: Logger;
}

const MAX_ERROR_LENGTH = 1000;

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
}

/**
 * The rules for delivering one email job (run by the background worker).
 *
 *   attempt succeeds                       -> status "sent"
 *   attempt fails, retries left, retryable -> stays "pending", outcome "retry"
 *   attempt fails, no retries left         -> status "failed"
 *   attempt fails, permanent error         -> status "failed" immediately (retrying cannot help)
 */
export class EmailDeliveryService {
  constructor(private readonly deps: EmailDeliveryServiceDependencies) {}

  async deliver(emailJobId: string, attempt: DeliveryAttempt): Promise<DeliveryOutcome> {
    const { repository, provider, logger } = this.deps;
    const log = logger.child({ emailJobId, attempt: attempt.retryCount + 1 });

    const job = await repository.recordAttemptStarted(emailJobId);
    if (!job) {
      // The queue delivers "at least once", so a job can arrive again after it finished.
      const existing = await repository.findById(emailJobId);
      log.warn({ status: existing?.status ?? 'missing' }, 'Skipping job that is not pending');
      return 'skipped';
    }

    let providerMessageId: string;
    try {
      ({ providerMessageId } = await provider.send({
        to: job.toEmail,
        subject: job.subject,
        text: job.body,
        idempotencyKey: `email-job-${job.id}`,
      }));
    } catch (error) {
      const reason = describeError(error);
      const retryable = !(error instanceof EmailDeliveryError) || error.retryable;
      const retriesLeft = attempt.retryLimit - attempt.retryCount;

      if (retryable && retriesLeft > 0) {
        await repository.recordFailedAttempt(job.id, reason);
        log.warn({ err: error, retriesLeft }, 'Email delivery failed; will retry');
        return 'retry';
      }

      await repository.markFailed(job.id, reason);
      log.error(
        { err: error, attempts: job.attempts, retryable },
        retryable ? 'Email delivery failed; no retries left' : 'Email delivery failed permanently',
      );
      return 'failed';
    }

    // If this write fails, the error propagates and the queue retries the job. The provider
    // receives the same idempotency key again, so the email is still sent only once.
    await repository.markSent(job.id, providerMessageId);
    log.info({ providerMessageId, attempts: job.attempts }, 'Email sent');
    return 'sent';
  }

  /**
   * Called for jobs that ran out of retries without finishing (e.g. the worker crashed or
   * timed out on the final attempt). Makes sure such jobs do not stay "pending" forever.
   */
  async handleExhaustedJob(emailJobId: string): Promise<boolean> {
    const changed = await this.deps.repository.markFailed(
      emailJobId,
      'All delivery attempts were used up (the last attempt did not complete)',
    );
    if (changed)
      this.deps.logger.error({ emailJobId }, 'Email job failed after exhausting retries');
    return changed;
  }
}
