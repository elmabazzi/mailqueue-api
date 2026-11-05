import path from 'node:path';

import { runner } from 'node-pg-migrate';
import pg from 'pg';

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../migrations');

/**
 * Returns the URL of the database that tests are allowed to wipe.
 *
 * Safety guard: the database name must end in "_test", so a misconfigured
 * TEST_DATABASE_URL can never point the tests at a development or production database.
 */
export function getTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Add it to .env (see .env.example) to run integration tests.',
    );
  }

  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests against database "${databaseName}": its name must end with "_test".`,
    );
  }
  return url;
}

/** Applies (up) or rolls back (down) migrations on the test database. */
export async function migrateTestDatabase(
  direction: 'up' | 'down',
  count: number = Infinity,
): Promise<void> {
  await runner({
    databaseUrl: getTestDatabaseUrl(),
    dir: MIGRATIONS_DIR,
    migrationsTable: 'pgmigrations',
    direction,
    count,
    checkOrder: true,
    log: () => {}, // keep test output readable
  });
}

/** Opens a plain client on the test database (tests may run SQL directly to verify results). */
export async function connectTestClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: getTestDatabaseUrl() });
  await client.connect();
  return client;
}
