import { PgBoss, type Job } from 'pg-boss';

import type { QueueJob, SendEmailJobPayload } from '../../models/queue.model.js';
import type { Transaction } from '../transaction.js';

export const SEND_EMAIL_QUEUE = 'email.send';
export const SEND_EMAIL_DEAD_LETTER_QUEUE = 'email.send.dead-letter';

export interface QueueConnectionOptions {
  connectionString: string;
  ssl: boolean;
  /** Postgres schema where pg-boss keeps its tables (default "pgboss"). */
  schema?: string;
  /** The worker runs maintenance (retries of expired jobs, cleanup); the API only sends jobs. */
  role: 'producer' | 'worker';
  onError: (error: Error) => void;
}

export interface RetryPolicy {
  /** Retries after the first attempt (3 => up to 4 attempts in total). */
  retryLimit: number;
  /** Delay before the first retry; doubles on each retry (exponential backoff). */
  retryDelaySeconds: number;
}

export type QueueJobHandler = (job: QueueJob) => Promise<void>;

export interface EmailQueue {
  /** Adds a "send this email" job. Pass a transaction to enqueue atomically with other writes. */
  enqueueSendEmail(payload: SendEmailJobPayload, tx?: Transaction): Promise<string>;
}

export function createQueueClient(options: QueueConnectionOptions): PgBoss {
  const boss = new PgBoss({
    connectionString: options.connectionString,
    ssl: options.ssl ? { rejectUnauthorized: true } : undefined,
    schema: options.schema ?? 'pgboss',
    application_name: `mailqueue-${options.role}`,
    max: 4,
    supervise: options.role === 'worker',
    schedule: false,
  });
  boss.on('error', options.onError);
  return boss;
}

export class PgBossEmailQueue implements EmailQueue {
  constructor(
    private readonly boss: PgBoss,
    private readonly retryPolicy: RetryPolicy,
  ) {}

  /** Starts pg-boss and creates (or updates) the queues. Safe to call from several processes. */
  async start(): Promise<void> {
    await this.boss.start();
    await this.boss.createQueue(SEND_EMAIL_DEAD_LETTER_QUEUE);

    const options = {
      retryLimit: this.retryPolicy.retryLimit,
      retryDelay: this.retryPolicy.retryDelaySeconds,
      retryBackoff: true,
      // A single send should take seconds. If a worker hangs or crashes, the job
      // expires after this long and is retried like any other failure.
      expireInSeconds: 120,
    };
    await this.boss.createQueue(SEND_EMAIL_QUEUE, {
      ...options,
      retryDelayMax: 3600,
      deadLetter: SEND_EMAIL_DEAD_LETTER_QUEUE,
    });
    // createQueue does not change an existing queue, so apply the current policy explicitly.
    await this.boss.updateQueue(SEND_EMAIL_QUEUE, options);
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }

  async enqueueSendEmail(payload: SendEmailJobPayload, tx?: Transaction): Promise<string> {
    const client = tx?.client;
    const id = await this.boss.send(SEND_EMAIL_QUEUE, payload, {
      db: client ? { executeSql: (text, values) => client.query(text, values) } : undefined,
    });
    if (!id) throw new Error('The queue did not accept the email job');
    return id;
  }

  /**
   * Starts consuming jobs.
   * - onSendEmail: runs for each attempt. Throwing makes the queue retry the job later.
   * - onDeadLetter: runs once a job has used up all retries without completing
   *   (for example because the worker crashed during the last attempt).
   */
  async consume(
    handlers: { onSendEmail: QueueJobHandler; onDeadLetter: QueueJobHandler },
    concurrency: number,
  ): Promise<void> {
    const toQueueJob = (job: Job<unknown>): QueueJob => ({
      id: job.id,
      data: job.data,
      retryCount: job.retryCount,
      retryLimit: this.retryPolicy.retryLimit,
    });

    await this.boss.work<unknown>(
      SEND_EMAIL_QUEUE,
      { localConcurrency: concurrency, pollingIntervalSeconds: 1 },
      async ([job]) => {
        if (job) await handlers.onSendEmail(toQueueJob(job));
      },
    );
    await this.boss.work<unknown>(
      SEND_EMAIL_DEAD_LETTER_QUEUE,
      { pollingIntervalSeconds: 5 },
      async ([job]) => {
        if (job) await handlers.onDeadLetter(toQueueJob(job));
      },
    );
  }
}
