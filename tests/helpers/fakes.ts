import { randomUUID } from 'node:crypto';

import { pino } from 'pino';

import type { EmailProvider } from '../../src/data/providers/resend.provider.js';
import type { EmailQueue } from '../../src/data/queue/emailQueue.js';
import type { EmailJobRepository } from '../../src/data/repositories/emailJob.repository.js';
import type { HealthRepository } from '../../src/data/repositories/health.repository.js';
import type { Transaction, TransactionRunner } from '../../src/data/transaction.js';
import type {
  EmailJob,
  EmailJobListFilter,
  EmailJobPage,
  NewEmailJob,
  OutgoingEmail,
} from '../../src/models/emailJob.model.js';
import type { SendEmailJobPayload } from '../../src/models/queue.model.js';

export const silentLogger = pino({ level: 'silent' });

/** In-memory stand-in for the email_jobs table, with the same status rules. */
export class InMemoryEmailJobRepository implements EmailJobRepository {
  readonly jobs = new Map<string, EmailJob>();

  private update(id: string, onlyIfPending: boolean, changes: Partial<EmailJob>): EmailJob | null {
    const job = this.jobs.get(id);
    if (!job || (onlyIfPending && job.status !== 'pending')) return null;
    const updated = { ...job, ...changes, updatedAt: new Date() };
    this.jobs.set(id, updated);
    return updated;
  }

  create(input: NewEmailJob): Promise<EmailJob> {
    const now = new Date();
    const job: EmailJob = {
      id: randomUUID(),
      ...input,
      status: 'pending',
      attempts: 0,
      lastError: null,
      providerMessageId: null,
      sentAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    return Promise.resolve(job);
  }

  findById(id: string): Promise<EmailJob | null> {
    return Promise.resolve(this.jobs.get(id) ?? null);
  }

  list(filter: EmailJobListFilter): Promise<EmailJobPage> {
    const all = [...this.jobs.values()]
      .filter((job) => !filter.status || job.status === filter.status)
      .reverse();
    return Promise.resolve({
      items: all.slice(filter.offset, filter.offset + filter.limit),
      total: all.length,
    });
  }

  recordAttemptStarted(id: string): Promise<EmailJob | null> {
    const job = this.jobs.get(id);
    return Promise.resolve(this.update(id, true, { attempts: (job?.attempts ?? 0) + 1 }));
  }

  markSent(id: string, providerMessageId: string): Promise<boolean> {
    const changed = this.update(id, true, {
      status: 'sent',
      providerMessageId,
      sentAt: new Date(),
      lastError: null,
    });
    return Promise.resolve(changed !== null);
  }

  recordFailedAttempt(id: string, error: string): Promise<boolean> {
    return Promise.resolve(this.update(id, true, { lastError: error }) !== null);
  }

  markFailed(id: string, error: string): Promise<boolean> {
    return Promise.resolve(this.update(id, true, { status: 'failed', lastError: error }) !== null);
  }
}

export class FakeEmailQueue implements EmailQueue {
  readonly enqueued: SendEmailJobPayload[] = [];
  failWith: Error | null = null;

  enqueueSendEmail(payload: SendEmailJobPayload): Promise<string> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.enqueued.push(payload);
    return Promise.resolve(randomUUID());
  }
}

export class FakeTransactionRunner implements TransactionRunner {
  runs = 0;
  async run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    this.runs++;
    return work({ client: null } as unknown as Transaction);
  }
}

/** Email provider whose result for each call is scripted by the test. */
export class FakeEmailProvider implements EmailProvider {
  readonly sent: OutgoingEmail[] = [];
  private readonly script: Array<Error | 'ok'> = [];
  /** Result used once the script runs out. */
  fallback: Error | 'ok' = 'ok';

  thenSucceed(): this {
    this.script.push('ok');
    return this;
  }

  thenFail(error: Error): this {
    this.script.push(error);
    return this;
  }

  send(email: OutgoingEmail): Promise<{ providerMessageId: string }> {
    const next = this.script.shift() ?? this.fallback;
    if (next instanceof Error) return Promise.reject(next);
    this.sent.push(email);
    return Promise.resolve({ providerMessageId: `msg_${this.sent.length}` });
  }
}

export class FakeHealthRepository implements HealthRepository {
  down = false;
  pingDatabase(): Promise<{ latencyMs: number }> {
    return this.down
      ? Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:5432'))
      : Promise.resolve({ latencyMs: 3 });
  }
}

/** Polls until `check` returns a value (not undefined), or fails after `timeoutMs`. */
export async function waitFor<T>(
  check: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
