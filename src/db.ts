import pg from 'pg';
import { attachDatabasePool } from '@vercel/functions';

export interface Database {
  query<T extends pg.QueryResultRow = any>(text: string, values?: any[]): Promise<{ rows: T[]; rowCount?: number | null }>;
  transaction<T>(fn: (db: Database) => Promise<T>, actorId?: number): Promise<T>;
  close(): Promise<void>;
}
export function createDatabase(url: string): Database {
  const pool = new pg.Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000 });
  pool.on('error', () => process.stderr.write('Koneksi database idle gagal.\n'));
  if (process.env.VERCEL) attachDatabasePool(pool);
  return {
    query: <T extends pg.QueryResultRow>(text: string, values?: any[]) => pool.query<T>(text, values),
    async transaction(fn, actorId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (actorId) await client.query("SELECT set_config('app.user_id', $1, true)", [actorId]);
        const scoped: Database = {
          query: <T extends pg.QueryResultRow>(text: string, values?: any[]) => client.query<T>(text, values),
          transaction: () => { throw new Error('Nested transaction tidak didukung.'); },
          close: async () => {},
        };
        const result = await fn(scoped);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
    close: () => pool.end(),
  };
}
