import { afterEach, describe, expect, it, vi } from 'vitest';

import { getTestDatabaseUrl } from '../../helpers/database.js';

describe('getTestDatabaseUrl safety guard', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the URL when the database name ends with _test', () => {
    vi.stubEnv('TEST_DATABASE_URL', 'postgres://u:p@localhost:5432/mailqueue_test');
    expect(getTestDatabaseUrl()).toBe('postgres://u:p@localhost:5432/mailqueue_test');
  });

  it('refuses a database whose name does not end with _test', () => {
    vi.stubEnv('TEST_DATABASE_URL', 'postgres://u:p@localhost:5432/mailqueue');
    expect(() => getTestDatabaseUrl()).toThrow(
      /Refusing to run tests against database "mailqueue"/,
    );
  });

  it('explains what to do when TEST_DATABASE_URL is missing', () => {
    vi.stubEnv('TEST_DATABASE_URL', '');
    expect(() => getTestDatabaseUrl()).toThrow(/TEST_DATABASE_URL is not set/);
  });
});
