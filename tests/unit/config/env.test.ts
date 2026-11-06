import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  parseApiConfig,
  parseBaseConfig,
  parseWorkerConfig,
} from '../../../src/config/env.js';

const DB = 'postgres://user:pass@localhost:5432/mailqueue';
const WORKER_ENV = { DATABASE_URL: DB, RESEND_API_KEY: 're_test_123', EMAIL_FROM: 'a@b.co' };

describe('parseApiConfig', () => {
  it('parses a valid environment and converts numbers and booleans', () => {
    const config = parseApiConfig({
      NODE_ENV: 'production',
      PORT: '8080',
      LOG_LEVEL: 'warn',
      DATABASE_URL: DB,
      DATABASE_SSL: 'true',
      API_KEY: 'a-very-long-secret-key',
    });

    expect(config).toMatchObject({
      NODE_ENV: 'production',
      PORT: 8080,
      LOG_LEVEL: 'warn',
      DATABASE_URL: DB,
      DATABASE_SSL: true,
      API_KEY: 'a-very-long-secret-key',
    });
  });

  it('applies defaults when optional variables are missing', () => {
    const config = parseApiConfig({ DATABASE_URL: DB });

    expect(config).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      DATABASE_SSL: false,
      DATABASE_POOL_MAX: 10,
      EMAIL_MAX_RETRIES: 3,
      EMAIL_RETRY_DELAY_SECONDS: 10,
    });
    expect(config.API_KEY).toBeUndefined();
  });

  it('treats empty values as not set, so defaults still apply', () => {
    const config = parseApiConfig({ DATABASE_URL: DB, PORT: '', LOG_LEVEL: '   ' });
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('accepts the postgresql:// scheme as well', () => {
    const url = 'postgresql://user:pass@db.example.com:5432/mailqueue';
    expect(parseApiConfig({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it('throws a ConfigError naming DATABASE_URL when it is missing', () => {
    expect(() => parseApiConfig({})).toThrow(ConfigError);
    expect(() => parseApiConfig({})).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-PostgreSQL URL without leaking the password in the error', () => {
    const attempt = () => parseApiConfig({ DATABASE_URL: 'mysql://admin:SuperSecret123@host/db' });
    expect(attempt).toThrow(/DATABASE_URL must be a postgres/);
    expect(attempt).not.toThrow(/SuperSecret123/);
  });

  it.each([
    ['not-a-number', /PORT must be a number/],
    ['0', /between 1 and 65535/],
    ['70000', /between 1 and 65535/],
    ['30.5', /whole number/],
  ])('rejects PORT=%s', (port, message) => {
    expect(() => parseApiConfig({ DATABASE_URL: DB, PORT: port })).toThrow(message);
  });

  it('requires an API_KEY in production', () => {
    expect(() => parseApiConfig({ DATABASE_URL: DB, NODE_ENV: 'production' })).toThrow(
      /API_KEY is required in production/,
    );
  });

  it('rejects a short API_KEY without printing it', () => {
    const attempt = () => parseApiConfig({ DATABASE_URL: DB, API_KEY: 'short-key' });
    expect(attempt).toThrow(/API_KEY must be at least 16 characters/);
    expect(attempt).not.toThrow(/short-key/);
  });

  it('rejects fewer than 3 retries (the project requires at least 3)', () => {
    expect(() => parseApiConfig({ DATABASE_URL: DB, EMAIL_MAX_RETRIES: '2' })).toThrow(
      /at least 3/,
    );
  });

  it('rejects unknown NODE_ENV, LOG_LEVEL and DATABASE_SSL values', () => {
    expect(() => parseApiConfig({ DATABASE_URL: DB, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
    expect(() => parseApiConfig({ DATABASE_URL: DB, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
    expect(() => parseApiConfig({ DATABASE_URL: DB, DATABASE_SSL: 'maybe' })).toThrow(
      /DATABASE_SSL/,
    );
  });

  it('reports every problem at once, not just the first one', () => {
    try {
      parseApiConfig({ PORT: 'abc', NODE_ENV: 'staging' });
      expect.unreachable('parseApiConfig should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/DATABASE_URL/);
      expect(message).toMatch(/PORT/);
      expect(message).toMatch(/NODE_ENV/);
    }
  });

  it('returns a read-only object', () => {
    expect(Object.isFrozen(parseApiConfig({ DATABASE_URL: DB }))).toBe(true);
  });

  describe('RUN_WORKER_IN_API (single-service mode)', () => {
    it('is off by default and then needs no Resend settings', () => {
      const config = parseApiConfig({ DATABASE_URL: DB });
      expect(config.RUN_WORKER_IN_API).toBe(false);
      expect(config.RESEND_API_KEY).toBeUndefined();
    });

    it('requires RESEND_API_KEY and EMAIL_FROM when turned on', () => {
      const attempt = () => parseApiConfig({ DATABASE_URL: DB, RUN_WORKER_IN_API: 'true' });
      expect(attempt).toThrow(/RESEND_API_KEY is required when RUN_WORKER_IN_API=true/);
      expect(attempt).toThrow(/EMAIL_FROM is required when RUN_WORKER_IN_API=true/);
    });

    it('accepts a complete single-service configuration', () => {
      const config = parseApiConfig({
        DATABASE_URL: DB,
        RUN_WORKER_IN_API: 'true',
        RESEND_API_KEY: 're_test_123',
        EMAIL_FROM: 'MailQueue <onboarding@resend.dev>',
        WORKER_CONCURRENCY: '3',
      });
      expect(config).toMatchObject({ RUN_WORKER_IN_API: true, WORKER_CONCURRENCY: 3 });
    });

    it('still validates the Resend key format when the worker is embedded', () => {
      expect(() =>
        parseApiConfig({
          DATABASE_URL: DB,
          RUN_WORKER_IN_API: 'true',
          RESEND_API_KEY: 'not-a-resend-key',
          EMAIL_FROM: 'a@b.co',
        }),
      ).toThrow(/must start with "re_"/);
    });
  });
});

describe('parseWorkerConfig', () => {
  it('parses a valid worker environment', () => {
    const config = parseWorkerConfig({ ...WORKER_ENV, WORKER_CONCURRENCY: '4' });
    expect(config).toMatchObject({ RESEND_API_KEY: 're_test_123', WORKER_CONCURRENCY: 4 });
  });

  it('requires RESEND_API_KEY and EMAIL_FROM', () => {
    expect(() => parseWorkerConfig({ DATABASE_URL: DB })).toThrow(
      /RESEND_API_KEY[\s\S]*EMAIL_FROM/,
    );
  });

  it('rejects a Resend key with the wrong format without printing it', () => {
    const attempt = () => parseWorkerConfig({ ...WORKER_ENV, RESEND_API_KEY: 'sk_live_secret' });
    expect(attempt).toThrow(/must start with "re_"/);
    expect(attempt).not.toThrow(/sk_live_secret/);
  });

  it('rejects an EMAIL_FROM without an email address', () => {
    expect(() => parseWorkerConfig({ ...WORKER_ENV, EMAIL_FROM: 'MailQueue' })).toThrow(
      /EMAIL_FROM/,
    );
  });
});

describe('parseBaseConfig', () => {
  it('only needs DATABASE_URL', () => {
    expect(parseBaseConfig({ DATABASE_URL: DB }).DATABASE_URL).toBe(DB);
  });
});
