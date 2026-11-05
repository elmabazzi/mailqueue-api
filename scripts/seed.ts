/**
 * Seed script: fills the database with example email jobs so the API has data to show.
 *
 *   npm run seed            (skips if the table already has rows)
 *   npm run seed -- --force (adds the examples anyway)
 *
 * It writes through the data layer's repository, so no SQL lives outside src/data.
 * The examples are history only (sent / failed); they are not queued, so nothing is emailed.
 */
import { config as loadDotenv } from 'dotenv';

import { parseBaseConfig } from '../src/config/env.js';
import { createDbPool } from '../src/data/db.js';
import { PgEmailJobRepository } from '../src/data/repositories/emailJob.repository.js';

loadDotenv({ quiet: true });

const SENT_EXAMPLES = [
  {
    toEmail: 'alice@example.com',
    subject: 'Welcome to MailQueue',
    body: 'Hi Alice, thanks for signing up!',
  },
  {
    toEmail: 'bob@example.com',
    subject: 'Your weekly report',
    body: 'Hi Bob, here is your weekly summary.',
  },
  {
    toEmail: 'carol@example.com',
    subject: 'Password changed',
    body: 'Hi Carol, your password was changed.',
  },
];

const FAILED_EXAMPLE = {
  toEmail: 'bounced@example.com',
  subject: 'Invoice #1042',
  body: 'Your invoice is attached.',
};

async function seed(): Promise<void> {
  const config = parseBaseConfig(process.env);
  if (config.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production database.');
  }

  const pool = createDbPool(
    {
      connectionString: config.DATABASE_URL,
      ssl: config.DATABASE_SSL,
      max: 2,
      applicationName: 'mailqueue-seed',
    },
    (error) => console.error('PostgreSQL pool error:', error.message),
  );
  const repository = new PgEmailJobRepository(pool);

  try {
    const existing = await repository.list({ limit: 1, offset: 0 });
    if (existing.total > 0 && !process.argv.includes('--force')) {
      console.log(
        `email_jobs already has ${existing.total} row(s); skipping. Use --force to add examples anyway.`,
      );
      return;
    }

    for (const [index, example] of SENT_EXAMPLES.entries()) {
      const job = await repository.create(example);
      await repository.recordAttemptStarted(job.id);
      await repository.markSent(job.id, `seed-message-${index + 1}`);
    }

    // A job that failed on its first attempt and on all 3 retries.
    const failed = await repository.create(FAILED_EXAMPLE);
    for (let attempt = 1; attempt <= config.EMAIL_MAX_RETRIES + 1; attempt++) {
      await repository.recordAttemptStarted(failed.id);
    }
    await repository.markFailed(
      failed.id,
      'Resend rejected the email (validation_error): example of a permanent failure',
    );

    const summary = await repository.list({ limit: 100, offset: 0 });
    console.log(`Seeded ${SENT_EXAMPLES.length + 1} email jobs (table now has ${summary.total}).`);
  } finally {
    await pool.end();
  }
}

seed().catch((error: unknown) => {
  console.error('Seeding failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
