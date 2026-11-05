import type { Request, Response } from 'express';

import type { HealthService } from '../../services/health.service.js';

export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /** GET /health: 200 when the app and database are up, 503 when the database is unreachable. */
  check = async (_req: Request, res: Response): Promise<void> => {
    const report = await this.healthService.check();
    res
      .status(report.status === 'ok' ? 200 : 503)
      .set('Cache-Control', 'no-store')
      .json(report);
  };
}
