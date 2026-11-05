/**
 * End-to-end flow with the REAL database and the REAL pg-boss queue:
 *   POST /emails -> email_jobs row + queue job -> worker -> status sent / failed.
 * Only Resend is replaced by a fake provider, so no real emails are sent.
 */
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  createDeadLetterHandler,
  createSendEmailHandler,
} from '../../src/api/workers/sendEmail.handler.js';
import { createDbPool, type DbPool } from '../../src/data/db.js';
import { createQueueClient, PgBossEmailQueue } from '../../src/data/queue/emailQueue.js';
import { PgEmailJobRepository } from '../../src/data/repositories/emailJob.repository.js';
import { PgHealthRepository } from '../../src/data/repositories/health.repository.js';
import { PgTransactionRunner } from '../../src/data/transaction.js';
import type { EmailJobDto } from '../../src/models/emailJob.model.js';
import { EmailDeliveryError } from '../../src/models/errors.js';
import { EmailDeliveryService } from '../../src/services/emailDelivery.service.js';
import { EmailService } from '../../src/services/email.service.js';
import { HealthService } from '../../src/services/health.service.js';
import { getTestDatabaseUrl, migrateTestDatabase } from '../helpers/database.js';
import { FakeEmailProvider, silentLogger, waitFor } from '../helpers/fakes.js';

const QUEUE_SCHEMA = 'pgboss_flow_test';
const RETRY_LIMIT = 3;

let pool: DbPool;
let queue: PgBossEmailQueue;
let provider: FakeEmailProvider;
let app: Express;

beforeAll(async () => {
  await migrateTestDatabase('up');
  const url = getTestDatabaseUrl();
  pool = createDbPool(
    { connectionString: url, ssl: false, max: 5, applicationName: 'test' },
    () => {},
  );
  await pool.query(`DROP SCHEMA IF EXISTS ${QUEUE_SCHEMA} CASCADE`);

  queue = new PgBossEmailQueue(
    createQueueClient({
      connectionString: url,
      ssl: false,
      schema: QUEUE_SCHEMA,
      role: 'worker',
      onError: () => {},
    }),
    // 1 second base delay keeps the test fast; backoff doubles it on every retry.
    { retryLimit: RETRY_LIMIT, retryDelaySeconds: 1 },
  );
  await queue.start();

  const repository = new PgEmailJobRepository(pool);
  provider = new FakeEmailProvider();
  const deliveryService = new EmailDeliveryService({ repository, provider, logger: silentLogger });
  await queue.consume(
    {
      onSendEmail: createSendEmailHandler({ deliveryService, logger: silentLogger }),
      onDeadLetter: createDeadLetterHandler({ deliveryService, logger: silentLogger }),
    },
    2,
  );

  app = createApp({
    emailService: new EmailService({
      repository,
      queue,
      transactions: new PgTransactionRunner(pool),
      logger: silentLogger,
    }),
    healthService: new HealthService({
      repository: new PgHealthRepository(pool),
      appInfo: { name: 'mailqueue-api', version: 'test', environment: 'test' },
      logger: silentLogger,
    }),
    logger: silentLogger,
  });
});

afterAll(async () => {
  await queue.stop();
  await pool.query(`DROP SCHEMA IF EXISTS ${QUEUE_SCHEMA} CASCADE`);
  await pool.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE email_jobs');
  provider.fallback = 'ok';
});

async function submit(to: string): Promise<string> {
  const res = await request(app)
    .post('/emails')
    .send({ to, subject: 'Integration test', body: 'Hello from the test suite' });
  expect(res.status).toBe(202);
  expect(res.body.data.status).toBe('pending');
  return (res.body.data as EmailJobDto).id;
}

/** Polls GET /emails/:id until the job is no longer pending. */
async function waitUntilFinished(id: string, timeoutMs: number): Promise<EmailJobDto> {
  return waitFor(async () => {
    const res = await request(app).get(`/emails/${id}`);
    const job = res.body.data as EmailJobDto;
    return job.status === 'pending' ? undefined : job;
  }, timeoutMs);
}

describe('email flow (API + queue + worker)', () => {
  it('delivers a queued email in the background and marks it sent', async () => {
    const id = await submit('success@example.com');

    const job = await waitUntilFinished(id, 15_000);

    expect(job).toMatchObject({ status: 'sent', attempts: 1, lastError: null });
    expect(job.providerMessageId).toMatch(/^msg_/);
    expect(job.sentAt).not.toBeNull();
    expect(provider.sent.find((email) => email.to === 'success@example.com')).toMatchObject({
      idempotencyKey: `email-job-${id}`,
    });
  });

  it('retries a failing email 3 times after the first attempt, then marks it failed', async () => {
    provider.fallback = new EmailDeliveryError('Resend is down (internal_server_error)', true);
    const id = await submit('always-fails@example.com');

    const job = await waitUntilFinished(id, 40_000);

    expect(job).toMatchObject({
      status: 'failed',
      attempts: RETRY_LIMIT + 1,
      lastError: 'Resend is down (internal_server_error)',
    });
  }, 45_000);

  it('fails immediately, without retries, on a permanent error', async () => {
    provider.fallback = new EmailDeliveryError('Invalid recipient (validation_error)', false);
    const id = await submit('invalid-recipient@example.com');

    const job = await waitUntilFinished(id, 15_000);

    expect(job).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('succeeds on a retry after a temporary failure', async () => {
    provider.thenFail(new EmailDeliveryError('rate limited', true));
    const id = await submit('flaky@example.com');

    const job = await waitUntilFinished(id, 20_000);

    expect(job).toMatchObject({ status: 'sent', attempts: 2, lastError: null });
  });
});

describe('transactional enqueue', () => {
  it('does not keep the email_jobs row when enqueueing fails', async () => {
    const repository = new PgEmailJobRepository(pool);
    const brokenQueue = {
      enqueueSendEmail: () => Promise.reject(new Error('queue unavailable')),
    };
    const service = new EmailService({
      repository,
      queue: brokenQueue,
      transactions: new PgTransactionRunner(pool),
      logger: silentLogger,
    });

    await expect(
      service.submit({ toEmail: 'a@example.com', subject: 's', body: 'b' }),
    ).rejects.toThrow('queue unavailable');
    expect((await repository.list({ limit: 10, offset: 0 })).total).toBe(0);
  });
});
