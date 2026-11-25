import { config } from 'dotenv';
import { createDatabase } from '../src/db.js';
import { SyncConflictError, syncInventory } from '../src/services/inventory-sync.js';
config({ path: '.env.local', quiet: true });
const [mode = '--dry-run'] = process.argv.slice(2);
if (!['--dry-run', '--commit'].includes(mode)) throw new Error('Pemakaian: npm run inventory:sync -- [--dry-run|--commit]');
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) throw new Error('Isi DATABASE_URL_UNPOOLED di .env.local.');

const db = createDatabase(url);
try {
  const database = (await db.query<{ d: string }>('SELECT current_database() AS d')).rows[0].d;
  console.log(`${mode === '--commit' ? 'MENULIS' : 'Dry-run (tidak menulis)'}: master inventaris -> kantor dan aset kerja di ${new URL(url).hostname}/${database}`);
  console.log(await syncInventory(db, mode !== '--commit'));
} catch (error) {
  if (error instanceof SyncConflictError) {
    console.error(`${error.message}:`);
    for (const issue of error.issues.slice(0, 50)) console.error(`  ${issue.message}`);
    if (error.issues.length > 50) console.error(`  ... dan ${error.issues.length - 50} masalah lain`);
    process.exit(1);
  }
  throw error;
} finally { await db.close(); }
