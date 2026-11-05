import { Resend } from 'resend';

import { EmailDeliveryError } from '../../models/errors.js';
import type { OutgoingEmail } from '../../models/emailJob.model.js';

export interface EmailProvider {
  /** Sends an email. Throws EmailDeliveryError (with `retryable`) if it could not be sent. */
  send(email: OutgoingEmail): Promise<{ providerMessageId: string }>;
}

/** The part of the Resend SDK we use (lets tests pass a fake client). */
export type ResendClient = Pick<Resend, 'emails'>;

/** Resend error names where trying again later can succeed. Everything else is permanent. */
const RETRYABLE_RESEND_ERRORS = new Set([
  'rate_limit_exceeded',
  'application_error',
  'internal_server_error',
  'concurrent_idempotent_requests',
]);

export function isRetryableResendError(error: { name: string; statusCode: number | null }) {
  return (
    RETRYABLE_RESEND_ERRORS.has(error.name) ||
    error.statusCode === null ||
    error.statusCode === 429 ||
    error.statusCode >= 500
  );
}

export class ResendEmailProvider implements EmailProvider {
  private readonly client: ResendClient;
  private readonly from: string;

  constructor(options: { apiKey: string; from: string; client?: ResendClient }) {
    this.client = options.client ?? new Resend(options.apiKey);
    this.from = options.from;
  }

  async send(email: OutgoingEmail): Promise<{ providerMessageId: string }> {
    let response: Awaited<ReturnType<ResendClient['emails']['send']>>;
    try {
      response = await this.client.emails.send(
        { from: this.from, to: [email.to], subject: email.subject, text: email.text },
        { idempotencyKey: email.idempotencyKey },
      );
    } catch (error) {
      // Network problems, timeouts, DNS failures...: worth retrying.
      const reason = error instanceof Error ? error.message : String(error);
      throw new EmailDeliveryError(`Could not reach Resend: ${reason}`, true);
    }

    if (response.error) {
      const { name, message, statusCode } = response.error;
      throw new EmailDeliveryError(
        `Resend rejected the email (${name}): ${message}`,
        isRetryableResendError({ name, statusCode }),
        name,
      );
    }
    return { providerMessageId: response.data.id };
  }
}
