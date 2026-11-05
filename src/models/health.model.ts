export interface AppInfo {
  readonly name: string;
  readonly version: string;
  readonly environment: string;
}

export interface HealthReport {
  status: 'ok' | 'error';
  timestamp: string;
  app: AppInfo & { status: 'up'; uptimeSeconds: number };
  database: { status: 'up'; latencyMs: number } | { status: 'down'; error: string };
}
