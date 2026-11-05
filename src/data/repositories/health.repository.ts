import type { DbPool } from '../db.js';

export interface HealthRepository {
  /** Runs a trivial query. Resolves with the round-trip time, or rejects if the DB is unreachable. */
  pingDatabase(timeoutMs: number): Promise<{ latencyMs: number }>;
}

export class PgHealthRepository implements HealthRepository {
  constructor(private readonly pool: DbPool) {}

  async pingDatabase(timeoutMs: number): Promise<{ latencyMs: number }> {
    const started = performance.now();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Database did not respond within ${timeoutMs} ms`)),
        timeoutMs,
      );
    });

    try {
      await Promise.race([this.pool.query('SELECT 1'), timeout]);
      return { latencyMs: Math.round(performance.now() - started) };
    } finally {
      clearTimeout(timer);
    }
  }
}
