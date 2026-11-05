import { describe, expect, it } from 'vitest';

import { ConfigError, parseConfig } from '../../../src/config/env.js';

const VALID_DB_URL = 'postgres://user:pass@localhost:5432/mailqueue';

describe('parseConfig', () => {
  it('parses a complete, valid environment and converts PORT to a number', () => {
    const config = parseConfig({
      NODE_ENV: 'production',
      PORT: '8080',
      LOG_LEVEL: 'warn',
      DATABASE_URL: VALID_DB_URL,
    });

    expect(config).toEqual({
      NODE_ENV: 'production',
      PORT: 8080,
      LOG_LEVEL: 'warn',
      DATABASE_URL: VALID_DB_URL,
    });
  });

  it('applies defaults when optional variables are missing', () => {
    const config = parseConfig({ DATABASE_URL: VALID_DB_URL });

    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('treats empty values as not set, so defaults still apply', () => {
    const config = parseConfig({ DATABASE_URL: VALID_DB_URL, PORT: '', LOG_LEVEL: '   ' });

    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('accepts the postgresql:// scheme as well', () => {
    const url = 'postgresql://user:pass@db.example.com:5432/mailqueue';
    expect(parseConfig({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it('throws a ConfigError naming DATABASE_URL when it is missing', () => {
    expect(() => parseConfig({})).toThrow(ConfigError);
    expect(() => parseConfig({})).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-PostgreSQL URL without leaking the password in the error', () => {
    const attempt = () => parseConfig({ DATABASE_URL: 'mysql://admin:SuperSecret123@host/db' });

    expect(attempt).toThrow(/DATABASE_URL must be a postgres/);
    expect(attempt).not.toThrow(/SuperSecret123/);
  });

  it.each([
    ['not-a-number', /PORT must be a number/],
    ['0', /between 1 and 65535/],
    ['70000', /between 1 and 65535/],
    ['30.5', /whole number/],
  ])('rejects PORT=%s', (port, message) => {
    expect(() => parseConfig({ DATABASE_URL: VALID_DB_URL, PORT: port })).toThrow(message);
  });

  it('rejects an unknown NODE_ENV and an unknown LOG_LEVEL', () => {
    expect(() => parseConfig({ DATABASE_URL: VALID_DB_URL, NODE_ENV: 'staging' })).toThrow(
      /NODE_ENV/,
    );
    expect(() => parseConfig({ DATABASE_URL: VALID_DB_URL, LOG_LEVEL: 'verbose' })).toThrow(
      /LOG_LEVEL/,
    );
  });

  it('reports every problem at once, not just the first one', () => {
    try {
      parseConfig({ PORT: 'abc', NODE_ENV: 'staging' });
      expect.unreachable('parseConfig should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/DATABASE_URL/);
      expect(message).toMatch(/PORT/);
      expect(message).toMatch(/NODE_ENV/);
    }
  });

  it('returns a read-only object', () => {
    const config = parseConfig({ DATABASE_URL: VALID_DB_URL });
    expect(Object.isFrozen(config)).toBe(true);
  });
});
