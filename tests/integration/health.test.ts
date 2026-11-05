import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createDbPool, type DbPool } from '../../src/data/db.js';
import { PgHealthRepository } from '../../src/data/repositories/health.repository.js';
import { HealthService } from '../../src/services/health.service.js';
import type { EmailService } from '../../src/services/email.service.js';
import { getTestDatabaseUrl } from '../helpers/database.js';
import { silentLogger } from '../helpers/fakes.js';

const pools: DbPool[] = [];

function appWithDatabase(connectionString: string) {
  const pool = createDbPool(
    { connectionString, ssl: false, max: 2, applicationName: 'test' },
    () => {},
  );
  pools.push(pool);
  return createApp({
    emailService: {} as EmailService, // not used by /health
    healthService: new HealthService({
      repository: new PgHealthRepository(pool),
      appInfo: { name: 'mailqueue-api', version: 'test', environment: 'test' },
      logger: silentLogger,
    }),
    logger: silentLogger,
  });
}

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
});

describe('GET /health against a real database', () => {
  it('returns 200 and measures database latency when PostgreSQL is reachable', async () => {
    const res = await request(appWithDatabase(getTestDatabaseUrl())).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database.status).toBe('up');
    expect(res.body.database.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns 503 when PostgreSQL is unreachable', async () => {
    // Port 1 on localhost: nothing listens there, so the connection is refused.
    const res = await request(
      appWithDatabase('postgres://mailqueue:wrong@127.0.0.1:1/mailqueue_test'),
    ).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: 'error',
      app: { status: 'up' },
      database: { status: 'down', error: 'Database is unreachable' },
    });
  });
});
