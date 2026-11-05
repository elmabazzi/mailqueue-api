import { beforeEach, describe, expect, it } from 'vitest';

import { EmailJobNotFoundError } from '../../../src/models/errors.js';
import { EmailService } from '../../../src/services/email.service.js';
import {
  FakeEmailQueue,
  FakeTransactionRunner,
  InMemoryEmailJobRepository,
  silentLogger,
} from '../../helpers/fakes.js';

let repository: InMemoryEmailJobRepository;
let queue: FakeEmailQueue;
let transactions: FakeTransactionRunner;
let service: EmailService;

const input = { toEmail: 'a@example.com', subject: 'Hi', body: 'Hello' };

beforeEach(() => {
  repository = new InMemoryEmailJobRepository();
  queue = new FakeEmailQueue();
  transactions = new FakeTransactionRunner();
  service = new EmailService({ repository, queue, transactions, logger: silentLogger });
});

describe('EmailService.submit', () => {
  it('stores a pending job and enqueues it inside one transaction', async () => {
    const job = await service.submit(input);

    expect(job).toMatchObject({ ...input, status: 'pending', attempts: 0 });
    expect(queue.enqueued).toEqual([{ emailJobId: job.id }]);
    expect(transactions.runs).toBe(1);
  });

  it('does not send anything itself; it only enqueues', async () => {
    await service.submit(input);
    expect([...repository.jobs.values()].every((job) => job.status === 'pending')).toBe(true);
  });

  it('fails when the job cannot be enqueued', async () => {
    queue.failWith = new Error('queue unavailable');
    await expect(service.submit(input)).rejects.toThrow('queue unavailable');
  });
});

describe('EmailService.getById', () => {
  it('returns the job', async () => {
    const job = await service.submit(input);
    await expect(service.getById(job.id)).resolves.toMatchObject({ id: job.id });
  });

  it('throws EmailJobNotFoundError for an unknown id', async () => {
    await expect(service.getById('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(
      EmailJobNotFoundError,
    );
  });
});

describe('EmailService.list', () => {
  it('passes the filter to the repository', async () => {
    await service.submit(input);
    await service.submit(input);
    const page = await service.list({ limit: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
  });
});
