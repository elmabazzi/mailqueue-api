import { beforeEach, describe, expect, it } from 'vitest';

import { EmailDeliveryError } from '../../../src/models/errors.js';
import { EmailDeliveryService } from '../../../src/services/emailDelivery.service.js';
import {
  FakeEmailProvider,
  InMemoryEmailJobRepository,
  silentLogger,
} from '../../helpers/fakes.js';

const RETRY_LIMIT = 3;
const temporary = () => new EmailDeliveryError('Resend rejected (rate_limit_exceeded)', true);
const permanent = () => new EmailDeliveryError('Resend rejected (validation_error)', false);

let repository: InMemoryEmailJobRepository;
let provider: FakeEmailProvider;
let service: EmailDeliveryService;
let jobId: string;

const attempt = (retryCount: number) => ({ retryCount, retryLimit: RETRY_LIMIT });

beforeEach(async () => {
  repository = new InMemoryEmailJobRepository();
  provider = new FakeEmailProvider();
  service = new EmailDeliveryService({ repository, provider, logger: silentLogger });
  jobId = (await repository.create({ toEmail: 'a@example.com', subject: 'Hi', body: 'Hello' })).id;
});

describe('EmailDeliveryService.deliver', () => {
  it('marks the job as sent and stores the provider message id', async () => {
    await expect(service.deliver(jobId, attempt(0))).resolves.toBe('sent');

    const job = await repository.findById(jobId);
    expect(job).toMatchObject({ status: 'sent', attempts: 1, providerMessageId: 'msg_1' });
    expect(job?.sentAt).toBeInstanceOf(Date);
  });

  it('sends the stored email with an idempotency key based on the job id', async () => {
    await service.deliver(jobId, attempt(0));
    expect(provider.sent[0]).toEqual({
      to: 'a@example.com',
      subject: 'Hi',
      text: 'Hello',
      idempotencyKey: `email-job-${jobId}`,
    });
  });

  it('keeps the job pending and asks for a retry after a temporary failure', async () => {
    provider.thenFail(temporary());

    await expect(service.deliver(jobId, attempt(0))).resolves.toBe('retry');
    expect(await repository.findById(jobId)).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'Resend rejected (rate_limit_exceeded)',
    });
  });

  it('retries 3 times after the first failure, then marks the job failed (4 attempts)', async () => {
    provider.fallback = temporary();

    const outcomes = [];
    for (let retryCount = 0; retryCount <= RETRY_LIMIT; retryCount++) {
      outcomes.push(await service.deliver(jobId, attempt(retryCount)));
    }

    expect(outcomes).toEqual(['retry', 'retry', 'retry', 'failed']);
    expect(await repository.findById(jobId)).toMatchObject({ status: 'failed', attempts: 4 });
  });

  it('succeeds on a retry after earlier failures', async () => {
    provider.thenFail(temporary()).thenFail(temporary()).thenSucceed();

    expect(await service.deliver(jobId, attempt(0))).toBe('retry');
    expect(await service.deliver(jobId, attempt(1))).toBe('retry');
    expect(await service.deliver(jobId, attempt(2))).toBe('sent');
    expect(await repository.findById(jobId)).toMatchObject({
      status: 'sent',
      attempts: 3,
      lastError: null,
    });
  });

  it('fails immediately on a permanent error, because retrying cannot help', async () => {
    provider.thenFail(permanent());

    await expect(service.deliver(jobId, attempt(0))).resolves.toBe('failed');
    expect(await repository.findById(jobId)).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('treats unexpected errors as temporary', async () => {
    provider.thenFail(new Error('socket hang up'));
    await expect(service.deliver(jobId, attempt(0))).resolves.toBe('retry');
  });

  it('skips a job that was already sent (the queue can deliver a job twice)', async () => {
    await service.deliver(jobId, attempt(0));
    await expect(service.deliver(jobId, attempt(0))).resolves.toBe('skipped');

    expect(provider.sent).toHaveLength(1);
    expect((await repository.findById(jobId))?.attempts).toBe(1);
  });

  it('skips a job that does not exist', async () => {
    await expect(service.deliver('00000000-0000-4000-8000-000000000000', attempt(0))).resolves.toBe(
      'skipped',
    );
  });

  it('truncates very long error messages before storing them', async () => {
    provider.thenFail(new Error('x'.repeat(5000)));
    await service.deliver(jobId, attempt(0));
    expect((await repository.findById(jobId))?.lastError?.length).toBeLessThanOrEqual(1001);
  });
});

describe('EmailDeliveryService.handleExhaustedJob', () => {
  it('marks a still-pending job as failed', async () => {
    await expect(service.handleExhaustedJob(jobId)).resolves.toBe(true);
    expect((await repository.findById(jobId))?.status).toBe('failed');
  });

  it('leaves a job that was already sent untouched', async () => {
    await service.deliver(jobId, attempt(0));
    await expect(service.handleExhaustedJob(jobId)).resolves.toBe(false);
    expect((await repository.findById(jobId))?.status).toBe('sent');
  });
});
