import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbPool, type DbPool } from '../../src/data/db.js';
import { PgEmailJobRepository } from '../../src/data/repositories/emailJob.repository.js';
import { PgTransactionRunner } from '../../src/data/transaction.js';
import { getTestDatabaseUrl, migrateTestDatabase } from '../helpers/database.js';

let pool: DbPool;
let repository: PgEmailJobRepository;

const input = { toEmail: 'a@example.com', subject: 'Hi', body: 'Hello' };

beforeAll(async () => {
  await migrateTestDatabase('up');
  pool = createDbPool(
    { connectionString: getTestDatabaseUrl(), ssl: false, max: 4, applicationName: 'test' },
    () => {},
  );
  repository = new PgEmailJobRepository(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE email_jobs');
});

describe('PgEmailJobRepository', () => {
  it('creates a pending job and finds it by id', async () => {
    const created = await repository.create(input);

    expect(created).toMatchObject({ ...input, status: 'pending', attempts: 0, lastError: null });
    await expect(repository.findById(created.id)).resolves.toEqual(created);
  });

  it('returns null for an unknown id', async () => {
    await expect(repository.findById('00000000-0000-4000-8000-000000000000')).resolves.toBeNull();
  });

  it('lists newest first, filters by status and paginates', async () => {
    const first = await repository.create({ ...input, subject: 'first' });
    const second = await repository.create({ ...input, subject: 'second' });
    await repository.recordAttemptStarted(first.id);
    await repository.markSent(first.id, 'msg-1');

    const all = await repository.list({ limit: 10, offset: 0 });
    expect(all.total).toBe(2);
    expect(all.items.map((job) => job.id)).toEqual([second.id, first.id]);

    const sent = await repository.list({ status: 'sent', limit: 10, offset: 0 });
    expect(sent.items.map((job) => job.id)).toEqual([first.id]);
    expect(sent.total).toBe(1);

    const page2 = await repository.list({ limit: 1, offset: 1 });
    expect(page2.items.map((job) => job.id)).toEqual([first.id]);
    expect(page2.total).toBe(2);
  });

  it('counts attempts and records errors while the job stays pending', async () => {
    const job = await repository.create(input);
    await repository.recordAttemptStarted(job.id);
    await repository.recordFailedAttempt(job.id, 'timeout');
    const again = await repository.recordAttemptStarted(job.id);

    expect(again).toMatchObject({ status: 'pending', attempts: 2, lastError: 'timeout' });
  });

  it('marks a job as sent with provider id and timestamp, clearing the last error', async () => {
    const job = await repository.create(input);
    await repository.recordFailedAttempt(job.id, 'timeout');

    await expect(repository.markSent(job.id, 'msg-1')).resolves.toBe(true);
    const sent = await repository.findById(job.id);
    expect(sent).toMatchObject({ status: 'sent', providerMessageId: 'msg-1', lastError: null });
    expect(sent?.sentAt).toBeInstanceOf(Date);
  });

  it('never changes a finished job (sent or failed)', async () => {
    const job = await repository.create(input);
    await repository.markSent(job.id, 'msg-1');

    await expect(repository.markFailed(job.id, 'late failure')).resolves.toBe(false);
    await expect(repository.recordAttemptStarted(job.id)).resolves.toBeNull();
    await expect(repository.recordFailedAttempt(job.id, 'x')).resolves.toBe(false);
    expect((await repository.findById(job.id))?.status).toBe('sent');
  });

  it('marks a job as failed with the error message', async () => {
    const job = await repository.create(input);
    await expect(repository.markFailed(job.id, 'bounced')).resolves.toBe(true);
    expect(await repository.findById(job.id)).toMatchObject({
      status: 'failed',
      lastError: 'bounced',
    });
  });

  it('discards a job created inside a transaction that is rolled back', async () => {
    const transactions = new PgTransactionRunner(pool);

    await expect(
      transactions.run(async (tx) => {
        await repository.create(input, tx);
        throw new Error('something failed after the insert');
      }),
    ).rejects.toThrow('something failed after the insert');

    expect((await repository.list({ limit: 10, offset: 0 })).total).toBe(0);
  });
});
