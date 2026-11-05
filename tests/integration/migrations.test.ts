import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { connectTestClient, migrateTestDatabase } from '../helpers/database.js';

/** Postgres error code for "check constraint violated". */
const CHECK_VIOLATION = '23514';

let client: pg.Client;

beforeAll(async () => {
  // Start from a completely empty schema, then apply every migration.
  await migrateTestDatabase('down');
  await migrateTestDatabase('up');
  client = await connectTestClient();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query('TRUNCATE email_jobs');
});

async function insertJob(columns: Record<string, unknown>): Promise<Record<string, unknown>> {
  const names = Object.keys(columns);
  const placeholders = names.map((_, index) => `$${index + 1}`);
  const result = await client.query(
    `INSERT INTO email_jobs (${names.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    Object.values(columns),
  );
  return result.rows[0] as Record<string, unknown>;
}

const validJob = { to_email: 'user@example.com', subject: 'Hello', body: 'Hi there' };

describe('migration: create email_jobs', () => {
  it('creates the email_jobs table with the expected columns', async () => {
    const result = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'email_jobs' ORDER BY ordinal_position`,
    );

    expect(result.rows.map((row) => row.column_name)).toEqual([
      'id',
      'to_email',
      'subject',
      'body',
      'status',
      'attempts',
      'last_error',
      'provider_message_id',
      'sent_at',
      'created_at',
      'updated_at',
    ]);
  });

  it('fills in sensible defaults for a new job', async () => {
    const row = await insertJob(validJob);

    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.last_error).toBeNull();
    expect(row.sent_at).toBeNull();
    expect(row.created_at).toBeInstanceOf(Date);
  });

  it('only allows the statuses pending, sent and failed', async () => {
    await expect(insertJob({ ...validJob, status: 'failed' })).resolves.toBeDefined();
    await expect(insertJob({ ...validJob, status: 'queued' })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'email_jobs_status_check',
    });
  });

  it('requires sent_at exactly when status is sent', async () => {
    await expect(insertJob({ ...validJob, status: 'sent' })).rejects.toMatchObject({
      constraint: 'email_jobs_sent_at_matches_status_check',
    });
    await expect(
      insertJob({ ...validJob, status: 'pending', sent_at: new Date() }),
    ).rejects.toMatchObject({ constraint: 'email_jobs_sent_at_matches_status_check' });

    await expect(
      insertJob({ ...validJob, status: 'sent', sent_at: new Date() }),
    ).resolves.toBeDefined();
  });

  it.each([
    ['to_email', '', 'email_jobs_to_email_length_check'],
    ['subject', '', 'email_jobs_subject_length_check'],
    ['subject', 'x'.repeat(999), 'email_jobs_subject_length_check'],
    ['body', '', 'email_jobs_body_length_check'],
  ])('rejects an invalid %s (%#)', async (column, value, constraint) => {
    await expect(insertJob({ ...validJob, [column]: value })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint,
    });
  });

  it('rejects a negative attempts count', async () => {
    await expect(insertJob({ ...validJob, attempts: -1 })).rejects.toMatchObject({
      constraint: 'email_jobs_attempts_check',
    });
  });

  it('updates updated_at automatically on every UPDATE', async () => {
    const past = new Date('2000-01-01T00:00:00Z');
    const row = await insertJob({ ...validJob, created_at: past, updated_at: past });

    const result = await client.query<{ updated_at: Date }>(
      `UPDATE email_jobs SET attempts = 1 WHERE id = $1 RETURNING updated_at`,
      [row.id],
    );

    expect(result.rows[0]?.updated_at.getTime()).toBeGreaterThan(past.getTime());
  });
});

describe('migration rollback', () => {
  it('can be rolled back and re-applied cleanly', async () => {
    await migrateTestDatabase('down');
    const afterDown = await client.query<{ exists: boolean }>(
      `SELECT to_regclass('email_jobs') IS NOT NULL AS exists`,
    );
    expect(afterDown.rows[0]?.exists).toBe(false);

    await migrateTestDatabase('up');
    const afterUp = await client.query<{ exists: boolean }>(
      `SELECT to_regclass('email_jobs') IS NOT NULL AS exists`,
    );
    expect(afterUp.rows[0]?.exists).toBe(true);
  });
});
