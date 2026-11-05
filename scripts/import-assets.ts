import { readFile } from 'node:fs/promises';
import { config } from 'dotenv';
import { z } from 'zod';
import { createDatabase } from '../src/db.js';
import { importAssets } from '../src/services/excel.js';
config({ path: '.env.local', quiet: true });
const [filename, username, mode = '--dry-run'] = process.argv.slice(2);
if (!filename || !username || !['--dry-run', '--commit'].includes(mode)) throw new Error('Pemakaian: npm run assets:import -- file.xlsx username-admin [--dry-run|--commit]');
const db = createDatabase(z.string().min(1).parse(process.env.DATABASE_URL));
try {
  const actor = (await db.query("SELECT id FROM users WHERE username=$1 AND role='admin'", [username.toLowerCase()])).rows[0];
  if (!actor) throw new Error('Akun admin tidak ditemukan.');
  console.log(await importAssets(db, await readFile(filename), actor.id, mode !== '--commit'));
} finally { await db.close(); }
