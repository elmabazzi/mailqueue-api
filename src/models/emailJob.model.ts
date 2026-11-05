/** The only statuses an email job can have (also enforced by a database CHECK constraint). */
export const EMAIL_STATUSES = ['pending', 'sent', 'failed'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/** An email job as stored in the database (entity). */
export interface EmailJob {
  readonly id: string;
  readonly toEmail: string;
  readonly subject: string;
  readonly body: string;
  readonly status: EmailStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly providerMessageId: string | null;
  readonly sentAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The data needed to create a new email job. */
export interface NewEmailJob {
  readonly toEmail: string;
  readonly subject: string;
  readonly body: string;
}

export interface EmailJobListFilter {
  readonly status?: EmailStatus | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface EmailJobPage {
  readonly items: readonly EmailJob[];
  readonly total: number;
}

/** The message handed to the email provider. */
export interface OutgoingEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** Lets the provider recognise a retry of the same email, so it is never sent twice. */
  readonly idempotencyKey: string;
}

/** The public JSON shape of an email job (response DTO). */
export interface EmailJobDto {
  id: string;
  to: string;
  subject: string;
  body: string;
  status: EmailStatus;
  attempts: number;
  lastError: string | null;
  providerMessageId: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toEmailJobDto(job: EmailJob): EmailJobDto {
  return {
    id: job.id,
    to: job.toEmail,
    subject: job.subject,
    body: job.body,
    status: job.status,
    attempts: job.attempts,
    lastError: job.lastError,
    providerMessageId: job.providerMessageId,
    sentAt: job.sentAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}
