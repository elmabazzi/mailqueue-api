import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../../src/api/app.js';
import { EmailService } from '../../../src/services/email.service.js';
import { HealthService } from '../../../src/services/health.service.js';
import {
  FakeEmailQueue,
  FakeHealthRepository,
  FakeTransactionRunner,
  InMemoryEmailJobRepository,
  silentLogger,
} from '../../helpers/fakes.js';

const API_KEY = 'test-api-key-0123456789';
const validEmail = { to: 'user@example.com', subject: 'Hello', body: 'Hi there!' };

let repository: InMemoryEmailJobRepository;
let queue: FakeEmailQueue;
let healthRepository: FakeHealthRepository;

function buildApp(apiKey?: string) {
  const emailService = new EmailService({
    repository,
    queue,
    transactions: new FakeTransactionRunner(),
    logger: silentLogger,
  });
  const healthService = new HealthService({
    repository: healthRepository,
    appInfo: { name: 'mailqueue-api', version: '1.0.0', environment: 'test' },
    logger: silentLogger,
  });
  return createApp({ emailService, healthService, logger: silentLogger, apiKey });
}

beforeEach(() => {
  repository = new InMemoryEmailJobRepository();
  queue = new FakeEmailQueue();
  healthRepository = new FakeHealthRepository();
});

describe('GET /health', () => {
  it('returns 200 with app and database status when the database is up', async () => {
    const res = await request(buildApp()).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      app: { name: 'mailqueue-api', status: 'up' },
      database: { status: 'up' },
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('returns 503 when the database is unreachable', async () => {
    healthRepository.down = true;
    const res = await request(buildApp()).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'error', database: { status: 'down' } });
  });

  it('does not require an API key', async () => {
    expect((await request(buildApp(API_KEY)).get('/health')).status).toBe(200);
  });
});

describe('POST /emails', () => {
  it('queues the email and returns 202 with the pending job and a Location header', async () => {
    const res = await request(buildApp()).post('/emails').send(validEmail);

    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({
      to: 'user@example.com',
      subject: 'Hello',
      status: 'pending',
      attempts: 0,
    });
    expect(res.headers.location).toBe(`/emails/${res.body.data.id}`);
    expect(queue.enqueued).toEqual([{ emailJobId: res.body.data.id }]);
  });

  it('trims the address and subject', async () => {
    const res = await request(buildApp())
      .post('/emails')
      .send({ ...validEmail, to: '  user@example.com ', subject: '  Hello  ' });
    expect(res.body.data).toMatchObject({ to: 'user@example.com', subject: 'Hello' });
  });

  it.each([
    ['an invalid email address', { ...validEmail, to: 'not-an-email' }, 'to'],
    ['a missing address', { subject: 'Hi', body: 'x' }, 'to'],
    ['an empty subject', { ...validEmail, subject: '   ' }, 'subject'],
    ['a subject with a line break', { ...validEmail, subject: 'Hi\r\nBcc: x@y.z' }, 'subject'],
    ['a subject that is too long', { ...validEmail, subject: 'x'.repeat(999) }, 'subject'],
    ['an empty body', { ...validEmail, body: '  ' }, 'body'],
    ['a body that is not a string', { ...validEmail, body: 42 }, 'body'],
    ['an unknown field', { ...validEmail, cc: 'x@y.z' }, ''],
  ])('rejects %s with 400', async (_label, payload, field) => {
    const res = await request(buildApp()).post('/emails').send(payload);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    if (field) {
      expect(res.body.error.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: field })]),
      );
    }
    expect(queue.enqueued).toHaveLength(0);
  });

  it('rejects malformed JSON with 400 INVALID_JSON', async () => {
    const res = await request(buildApp())
      .post('/emails')
      .set('Content-Type', 'application/json')
      .send('{"to": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('rejects a body larger than the limit with 413', async () => {
    const res = await request(buildApp())
      .post('/emails')
      .send({ ...validEmail, body: 'x'.repeat(300_000) });
    expect(res.status).toBe(413);
  });

  it('returns 500 with a generic message when queuing fails unexpectedly', async () => {
    queue.failWith = new Error('connection to 10.0.0.5 refused');
    const res = await request(buildApp()).post('/emails').send(validEmail);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
  });
});

describe('GET /emails/:id', () => {
  it('returns the job', async () => {
    const created = await request(buildApp()).post('/emails').send(validEmail);
    const res = await request(buildApp()).get(`/emails/${created.body.data.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(created.body.data.id);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request(buildApp()).get('/emails/00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EMAIL_JOB_NOT_FOUND');
  });

  it('returns 400 for an id that is not a UUID', async () => {
    const res = await request(buildApp()).get('/emails/123');
    expect(res.status).toBe(400);
  });
});

describe('GET /emails', () => {
  it('lists jobs with pagination info', async () => {
    const app = buildApp();
    await request(app).post('/emails').send(validEmail);
    await request(app).post('/emails').send(validEmail);

    const res = await request(app).get('/emails?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination).toEqual({ limit: 1, offset: 0, total: 2 });
  });

  it('filters by status', async () => {
    const app = buildApp();
    await request(app).post('/emails').send(validEmail);
    expect((await request(app).get('/emails?status=sent')).body.data).toHaveLength(0);
    expect((await request(app).get('/emails?status=pending')).body.data).toHaveLength(1);
  });

  it.each(['status=queued', 'limit=0', 'limit=101', 'offset=-1'])(
    'rejects ?%s with 400',
    async (query) => {
      expect((await request(buildApp()).get(`/emails?${query}`)).status).toBe(400);
    },
  );
});

describe('API key protection', () => {
  it('rejects /emails requests without a key with 401', async () => {
    const res = await request(buildApp(API_KEY)).post('/emails').send(validEmail);
    expect(res.status).toBe(401);
    expect(queue.enqueued).toHaveLength(0);
  });

  it('rejects a wrong key', async () => {
    const res = await request(buildApp(API_KEY)).get('/emails').set('X-API-Key', 'wrong');
    expect(res.status).toBe(401);
  });

  it('accepts the key in X-API-Key or as a Bearer token', async () => {
    const app = buildApp(API_KEY);
    expect((await request(app).get('/emails').set('X-API-Key', API_KEY)).status).toBe(200);
    expect(
      (await request(app).get('/emails').set('Authorization', `Bearer ${API_KEY}`)).status,
    ).toBe(200);
  });
});

describe('other routes', () => {
  it('returns 404 JSON for unknown routes', async () => {
    const res = await request(buildApp()).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
  });

  it('returns a request id header and hides the X-Powered-By header', async () => {
    const res = await request(buildApp()).get('/health');
    expect(res.headers['x-request-id']).toMatch(/^[\w-]+$/);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
