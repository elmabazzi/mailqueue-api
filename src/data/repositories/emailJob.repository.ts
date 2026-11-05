import type {
  EmailJob,
  EmailJobListFilter,
  EmailJobPage,
  EmailStatus,
  NewEmailJob,
} from '../../models/emailJob.model.js';
import type { DbPool } from '../db.js';
import type { Transaction } from '../transaction.js';

/** All reads and writes of the email_jobs table. This is the only place its SQL lives. */
export interface EmailJobRepository {
  create(input: NewEmailJob, tx?: Transaction): Promise<EmailJob>;
  findById(id: string): Promise<EmailJob | null>;
  list(filter: EmailJobListFilter): Promise<EmailJobPage>;
  /** Counts a new delivery attempt. Returns null if the job does not exist or is no longer pending. */
  recordAttemptStarted(id: string): Promise<EmailJob | null>;
  /** pending -> sent. Returns false if the job was not pending. */
  markSent(id: string, providerMessageId: string): Promise<boolean>;
  /** Stores the error of a failed attempt; the job stays pending so it can be retried. */
  recordFailedAttempt(id: string, error: string): Promise<boolean>;
  /** pending -> failed. Returns false if the job was not pending. */
  markFailed(id: string, error: string): Promise<boolean>;
}

interface EmailJobRow {
  id: string;
  to_email: string;
  subject: string;
  body: string;
  status: EmailStatus;
  attempts: number;
  last_error: string | null;
  provider_message_id: string | null;
  sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, to_email, subject, body, status, attempts, last_error,
  provider_message_id, sent_at, created_at, updated_at`;

function toEmailJob(row: EmailJobRow): EmailJob {
  return {
    id: row.id,
    toEmail: row.to_email,
    subject: row.subject,
    body: row.body,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    providerMessageId: row.provider_message_id,
    sentAt: row.sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PgEmailJobRepository implements EmailJobRepository {
  constructor(private readonly pool: DbPool) {}

  async create(input: NewEmailJob, tx?: Transaction): Promise<EmailJob> {
    const db = tx?.client ?? this.pool;
    const result = await db.query<EmailJobRow>(
      `INSERT INTO email_jobs (to_email, subject, body)
       VALUES ($1, $2, $3)
       RETURNING ${COLUMNS}`,
      [input.toEmail, input.subject, input.body],
    );
    return toEmailJob(result.rows[0]!);
  }

  async findById(id: string): Promise<EmailJob | null> {
    const result = await this.pool.query<EmailJobRow>(
      `SELECT ${COLUMNS} FROM email_jobs WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toEmailJob(row) : null;
  }

  async list(filter: EmailJobListFilter): Promise<EmailJobPage> {
    const status = filter.status ?? null;
    const [items, count] = await Promise.all([
      this.pool.query<EmailJobRow>(
        `SELECT ${COLUMNS} FROM email_jobs
         WHERE ($1::text IS NULL OR status = $1)
         ORDER BY created_at DESC, id DESC
         LIMIT $2 OFFSET $3`,
        [status, filter.limit, filter.offset],
      ),
      this.pool.query<{ total: string }>(
        `SELECT count(*) AS total FROM email_jobs WHERE ($1::text IS NULL OR status = $1)`,
        [status],
      ),
    ]);
    return { items: items.rows.map(toEmailJob), total: Number(count.rows[0]?.total ?? 0) };
  }

  async recordAttemptStarted(id: string): Promise<EmailJob | null> {
    const result = await this.pool.query<EmailJobRow>(
      `UPDATE email_jobs SET attempts = attempts + 1
       WHERE id = $1 AND status = 'pending'
       RETURNING ${COLUMNS}`,
      [id],
    );
    const row = result.rows[0];
    return row ? toEmailJob(row) : null;
  }

  async markSent(id: string, providerMessageId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE email_jobs
       SET status = 'sent', provider_message_id = $2, sent_at = now(), last_error = NULL
       WHERE id = $1 AND status = 'pending'`,
      [id, providerMessageId],
    );
    return result.rowCount === 1;
  }

  async recordFailedAttempt(id: string, error: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE email_jobs SET last_error = $2 WHERE id = $1 AND status = 'pending'`,
      [id, error],
    );
    return result.rowCount === 1;
  }

  async markFailed(id: string, error: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE email_jobs SET status = 'failed', last_error = $2
       WHERE id = $1 AND status = 'pending'`,
      [id, error],
    );
    return result.rowCount === 1;
  }
}
