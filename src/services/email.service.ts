import type { EmailQueue } from '../data/queue/emailQueue.js';
import type { EmailJobRepository } from '../data/repositories/emailJob.repository.js';
import type { TransactionRunner } from '../data/transaction.js';
import type { Logger } from '../lib/logger.js';
import type {
  EmailJob,
  EmailJobListFilter,
  EmailJobPage,
  NewEmailJob,
} from '../models/emailJob.model.js';
import { EmailJobNotFoundError } from '../models/errors.js';

export interface EmailServiceDependencies {
  repository: EmailJobRepository;
  queue: EmailQueue;
  transactions: TransactionRunner;
  logger: Logger;
}

/** Use cases for submitting and inspecting emails. Never sends email itself. */
export class EmailService {
  constructor(private readonly deps: EmailServiceDependencies) {}

  /**
   * Stores a new email job as "pending" and puts it on the queue.
   * Both happen in ONE transaction: either the job is saved AND queued, or neither,
   * so there can never be a pending job that no worker will pick up.
   */
  async submit(input: NewEmailJob): Promise<EmailJob> {
    const { repository, queue, transactions, logger } = this.deps;

    const job = await transactions.run(async (tx) => {
      const created = await repository.create(input, tx);
      await queue.enqueueSendEmail({ emailJobId: created.id }, tx);
      return created;
    });

    logger.info({ emailJobId: job.id }, 'Email job queued');
    return job;
  }

  async getById(id: string): Promise<EmailJob> {
    const job = await this.deps.repository.findById(id);
    if (!job) throw new EmailJobNotFoundError(id);
    return job;
  }

  async list(filter: EmailJobListFilter): Promise<EmailJobPage> {
    return this.deps.repository.list(filter);
  }
}
