import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { loadConfig, today, type Config } from '../src/config.js';
import type { TelegramSender } from '../src/routes/notifications.js';
import ExcelJS from 'exceljs';
import { migrate } from '../scripts/migration-runner.js';
export async function fixture(overrides: Partial<Config> = {}, sendTelegram?: TelegramSender) {
  const engine = new PGlite();
  await engine.waitReady;
  const query = async <T extends Record<string, any> = any>(sql: string, params?: any[]) => {
    const result = await engine.query<T>(sql, params);
    return { rows: result.rows, rowCount: result.affectedRows };
  };
  const db: Database = {
    query,
    async transaction(fn, actorId) {
      return engine.transaction(async pg => {
        const tx: Database = {
          query: async <T extends Record<string, any> = any>(sql: string, params?: any[]) => {
            // pg accepts multi-statement migration SQL; PGlite's extended protocol needs exec for it.
            if (!params && (sql.includes('CREATE TABLE') || sql.includes('CREATE TYPE'))) { await pg.exec(sql); return { rows: [] as T[] }; }
            const result = await pg.query<T>(sql, params); return { rows: result.rows, rowCount: result.affectedRows };
          },
          transaction: async () => { throw new Error('Nested transaction'); }, close: async () => {},
        };
        if (actorId) await tx.query("SELECT set_config('app.user_id',$1,true)", [actorId]);
        return fn(tx);
      });
    },
    close: () => engine.close(),
  };
  await migrate(db);
  const config: Config = { ...loadConfig({ DATABASE_URL: 'postgresql://test:test@localhost/test', AUTH_SECRET: 'test-auth-secret-at-least-32-characters', CRON_SECRET: 'test-cron-secret-at-least-32-characters', NODE_ENV: 'test', TELEGRAM_CHAT_ID: '-1001234' }), ...overrides };
  const password = 'caps2tone-test-password'; const hash = await hashPassword(password);
  const admin = (await db.query("INSERT INTO users(name,username,password_hash,role) VALUES('Admin','admin',$1,'admin') RETURNING id", [hash])).rows[0].id;
  const tech = (await db.query("INSERT INTO users(name,username,password_hash,role,telegram_chat_id) VALUES('Teknisi','teknisi',$1,'teknisi','12345') RETURNING id", [hash])).rows[0].id;
  const other = (await db.query("INSERT INTO users(name,username,password_hash,role) VALUES('Lain','lain',$1,'teknisi') RETURNING id", [hash])).rows[0].id;
  await db.query("INSERT INTO technician_areas(user_id,area) VALUES($1,'grobogan'),($2,'solo')", [tech, other]);
  const office = (await db.query("INSERT INTO offices(code,name,area) VALUES('KTR-GRB','Grobogan','grobogan') RETURNING id")).rows[0].id;
  const otherOffice = (await db.query("INSERT INTO offices(code,name,area) VALUES('KTR-SLO','Solo','solo') RETURNING id")).rows[0].id;
  const day = today(config.APP_TIMEZONE);
  const schedule = (await db.query("INSERT INTO mapping_schedules(office_id,area,scheduled_date,assigned_to,created_by) VALUES($1,'grobogan',$2,$3,$4) RETURNING id", [office, day, tech, admin])).rows[0].id;
  const asset = (await db.query("INSERT INTO assets(eq,kind,serial_number,office_id,ref,status) VALUES('EQ-001','chassis','SN-001',$1,'OLD','Aktif') RETURNING id", [office])).rows[0].id;
  const otherAsset = (await db.query("INSERT INTO assets(eq,kind,serial_number,office_id) VALUES('EQ-OTHER','chassis','SN-OTHER',$1) RETURNING id", [otherOffice])).rows[0].id;
  const app = await buildApp({ db, config, sendTelegram });
  async function login(username = 'admin') {
    const result = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
    if (result.statusCode !== 200) throw new Error(result.body);
    const session = result.cookies.find(c => c.name === 'caps2tone_session')!;
    return { cookie: `caps2tone_session=${session.value}`, 'x-csrf-token': result.json().data.csrf_token };
  }
  return { app, db, engine, config, admin, tech, other, office, otherOffice, schedule, asset, otherAsset, day, login,
    async close() { await app.close(); await db.close(); } };
}
export async function excel(rows: any[][]) {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Aset');
  sheet.addRow(['EQ', 'Jenis', 'Serial Number', 'Kode Kantor', 'SN Chassis', 'REF', 'Status', 'Kondisi', 'Kode Aset']);
  rows.forEach(row => sheet.addRow(row));
  return Buffer.from(await book.xlsx.writeBuffer());
}
export function multipartFile(buffer: Buffer) {
  const boundary = 'caps2tone-test-boundary';
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="assets.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`),
    buffer, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]) };
}
export const missingId = () => 2147483647;
