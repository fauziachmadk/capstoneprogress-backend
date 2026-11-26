import { readFile } from 'node:fs/promises';
import { config } from 'dotenv';
import { createDatabase } from '../src/db.js';
import { ConflictError, importInventory, parseInventory, type Issue } from '../src/services/inventory-import.js';
config({ path: '.env.local', quiet: true });
const [filename, mode = '--dry-run'] = process.argv.slice(2);
if (!filename || !['--dry-run', '--commit'].includes(mode)) throw new Error('Pemakaian: npm run inventory:import -- file.csv [--dry-run|--commit]');
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) throw new Error('Isi DATABASE_URL_UNPOOLED di .env.local.');

const show = (issues: Issue[]) => {
  for (const issue of issues.slice(0, 50)) console.error(`  baris ${issue.line}: ${issue.message}`);
  if (issues.length > 50) console.error(`  ... dan ${issues.length - 50} masalah lain`);
};
const { rows, errors } = parseInventory(await readFile(filename, 'utf8'));
if (errors.length) { console.error(`CSV tidak valid (${errors.length} masalah):`); show(errors); process.exit(1); }

const target = new URL(url);
const db = createDatabase(url);
try {
  const database = (await db.query<{ d: string }>('SELECT current_database() AS d')).rows[0].d;
  console.log(`${mode === '--commit' ? 'MENULIS' : 'Dry-run (tidak menulis)'}: ${rows.length} baris -> ${target.hostname}/${database}`);
  console.log(await importInventory(db, rows, mode !== '--commit'));
} catch (error) {
  if (error instanceof ConflictError) { console.error(`${error.message}:`); show(error.issues); process.exit(1); }
  throw error;
} finally { await db.close(); }
