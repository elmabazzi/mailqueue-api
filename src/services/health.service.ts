import type { HealthRepository } from '../data/repositories/health.repository.js';
import type { Logger } from '../lib/logger.js';
import type { AppInfo, HealthReport } from '../models/health.model.js';

export interface HealthServiceDependencies {
  repository: HealthRepository;
  appInfo: AppInfo;
  logger: Logger;
  databaseTimeoutMs?: number;
}

export class HealthService {
  constructor(private readonly deps: HealthServiceDependencies) {}

  async check(): Promise<HealthReport> {
    const { repository, appInfo, logger, databaseTimeoutMs = 2000 } = this.deps;

    let database: HealthReport['database'];
    try {
      const { latencyMs } = await repository.pingDatabase(databaseTimeoutMs);
      database = { status: 'up', latencyMs };
    } catch (error) {
      // The real reason goes to the logs only; the public response must not reveal
      // internal hostnames or connection details.
      logger.warn({ err: error }, 'Health check: database unreachable');
      database = { status: 'down', error: 'Database is unreachable' };
    }

    return {
      status: database.status === 'up' ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
      app: { ...appInfo, status: 'up', uptimeSeconds: Math.round(process.uptime()) },
      database,
    };
  }
}
