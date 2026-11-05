import type pg from 'pg';

import type { DbPool } from './db.js';

/**
 * A database transaction in progress. Services pass it to repositories and the queue
 * so that several writes either all succeed or are all undone; they never use it directly.
 */
export class Transaction {
  /** @internal Used only inside the data layer. */
  constructor(readonly client: pg.PoolClient) {}
}

export interface TransactionRunner {
  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}

export class PgTransactionRunner implements TransactionRunner {
  constructor(private readonly pool: DbPool) {}

  async run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let connectionBroken = false;
    try {
      await client.query('BEGIN');
      const result = await work(new Transaction(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        connectionBroken = true; // do not return a broken connection to the pool
      }
      throw error;
    } finally {
      client.release(connectionBroken);
    }
  }
}
