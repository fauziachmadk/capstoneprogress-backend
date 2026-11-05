import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { Database } from '../src/db.js';
export const migrationDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
export async function migrate(db: Database, directory = migrationDirectory) {
  const files = (await readdir(directory)).filter(f => /^\d+.*\.sql$/.test(f)).sort();
  await db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(731941)');
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const name of files) {
      const sql = await readFile(`${directory}/${name}`, 'utf8');
      const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
      const previous = (await tx.query('SELECT checksum FROM schema_migrations WHERE name=$1', [name])).rows[0];
      if (previous) {
        if (previous.checksum !== checksum) throw new Error(`Migrasi ${name} sudah berubah. Buat migrasi baru.`);
        continue;
      }
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [name, checksum]);
    }
  });
}
