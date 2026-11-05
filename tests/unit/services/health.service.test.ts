import { beforeEach, describe, expect, it } from 'vitest';

import { HealthService } from '../../../src/services/health.service.js';
import { FakeHealthRepository, silentLogger } from '../../helpers/fakes.js';

let repository: FakeHealthRepository;
let service: HealthService;

beforeEach(() => {
  repository = new FakeHealthRepository();
  service = new HealthService({
    repository,
    appInfo: { name: 'mailqueue-api', version: '1.0.0', environment: 'test' },
    logger: silentLogger,
  });
});

describe('HealthService.check', () => {
  it('reports ok with app and database status when the database responds', async () => {
    const report = await service.check();

    expect(report.status).toBe('ok');
    expect(report.app).toMatchObject({ name: 'mailqueue-api', version: '1.0.0', status: 'up' });
    expect(report.app.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(report.database).toEqual({ status: 'up', latencyMs: 3 });
    expect(Date.parse(report.timestamp)).not.toBeNaN();
  });

  it('reports error when the database is unreachable, without leaking connection details', async () => {
    repository.down = true;
    const report = await service.check();

    expect(report.status).toBe('error');
    expect(report.app.status).toBe('up');
    expect(report.database).toEqual({ status: 'down', error: 'Database is unreachable' });
    expect(JSON.stringify(report)).not.toContain('10.0.0.5');
  });
});
