import { beforeEach, describe, expect, it } from 'vitest';

import {
  createDeadLetterHandler,
  createSendEmailHandler,
  RetryLaterError,
} from '../../../src/api/workers/sendEmail.handler.js';
import { EmailDeliveryError } from '../../../src/models/errors.js';
import { EmailDeliveryService } from '../../../src/services/emailDelivery.service.js';
import {
  FakeEmailProvider,
  InMemoryEmailJobRepository,
  silentLogger,
} from '../../helpers/fakes.js';

let repository: InMemoryEmailJobRepository;
let provider: FakeEmailProvider;
let deps: { deliveryService: EmailDeliveryService; logger: typeof silentLogger };
let emailJobId: string;

beforeEach(async () => {
  repository = new InMemoryEmailJobRepository();
  provider = new FakeEmailProvider();
  deps = {
    deliveryService: new EmailDeliveryService({ repository, provider, logger: silentLogger }),
    logger: silentLogger,
  };
  emailJobId = (await repository.create({ toEmail: 'a@b.co', subject: 's', body: 'b' })).id;
});

const queueJob = (data: unknown, retryCount = 0) => ({ id: 'q1', data, retryCount, retryLimit: 3 });

describe('send-email job handler', () => {
  it('completes normally when the email is sent', async () => {
    await expect(createSendEmailHandler(deps)(queueJob({ emailJobId }))).resolves.toBeUndefined();
    expect((await repository.findById(emailJobId))?.status).toBe('sent');
  });

  it('throws RetryLaterError so the queue retries a temporary failure', async () => {
    provider.thenFail(new EmailDeliveryError('rate limited', true));
    await expect(createSendEmailHandler(deps)(queueJob({ emailJobId }))).rejects.toBeInstanceOf(
      RetryLaterError,
    );
  });

  it('completes normally (no retry) once the job has failed permanently', async () => {
    provider.thenFail(new EmailDeliveryError('bad address', false));
    await expect(createSendEmailHandler(deps)(queueJob({ emailJobId }))).resolves.toBeUndefined();
    expect((await repository.findById(emailJobId))?.status).toBe('failed');
  });

  it('drops a job with an invalid payload instead of retrying it forever', async () => {
    await expect(createSendEmailHandler(deps)(queueJob({ wrong: 1 }))).resolves.toBeUndefined();
    expect(provider.sent).toHaveLength(0);
  });
});

describe('dead-letter job handler', () => {
  it('marks the email job as failed', async () => {
    await createDeadLetterHandler(deps)(queueJob({ emailJobId }));
    expect((await repository.findById(emailJobId))?.status).toBe('failed');
  });
});
