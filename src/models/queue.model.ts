import { z } from 'zod';

/** The data stored in each queue job: just a reference to the email_jobs row. */
export const SendEmailJobPayloadSchema = z.object({
  emailJobId: z.uuid(),
});
export type SendEmailJobPayload = z.infer<typeof SendEmailJobPayloadSchema>;

/** A queue job as handed to a job handler (independent of the queue library). */
export interface QueueJob {
  readonly id: string;
  readonly data: unknown;
  /** 0 on the first attempt, 1 on the first retry, and so on. */
  readonly retryCount: number;
  /** How many retries are allowed after the first attempt. */
  readonly retryLimit: number;
}

/** Information about the current delivery attempt. */
export interface DeliveryAttempt {
  readonly retryCount: number;
  readonly retryLimit: number;
}

/**
 * What happened when the worker tried to deliver an email.
 * - sent:    delivered; status is now "sent".
 * - retry:   failed temporarily; status stays "pending" and the queue will try again.
 * - failed:  failed permanently (or out of retries); status is now "failed".
 * - skipped: nothing to do (job missing, or already sent/failed).
 */
export type DeliveryOutcome = 'sent' | 'retry' | 'failed' | 'skipped';
