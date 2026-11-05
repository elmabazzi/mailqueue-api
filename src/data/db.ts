import pg from 'pg';

export type DbPool = pg.Pool;

export interface DatabaseOptions {
  connectionString: string;
  ssl: boolean;
  max: number;
  applicationName: string;
}

/** Creates the shared PostgreSQL connection pool. */
export function createDbPool(options: DatabaseOptions, onError: (error: Error) => void): DbPool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    ssl: options.ssl ? { rejectUnauthorized: true } : undefined,
    max: options.max,
    application_name: options.applicationName,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  // An idle connection can break (e.g. database restart). Without this listener
  // Node would treat it as an unhandled error and crash the process.
  pool.on('error', onError);
  return pool;
}
