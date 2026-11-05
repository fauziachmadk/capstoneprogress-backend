import { config } from 'dotenv';
import { createDatabase } from '../src/db.js';
import { migrate } from './migration-runner.js';
config({ path: '.env.local', quiet: true });
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) throw new Error('Isi DATABASE_URL_UNPOOLED di .env.local.');
if (new URL(url).hostname.includes('-pooler')) throw new Error('Migrasi memerlukan koneksi direct, bukan pooler.');
const db = createDatabase(url);
try { await migrate(db); console.log('Migrasi berhasil.'); }
finally { await db.close(); }
