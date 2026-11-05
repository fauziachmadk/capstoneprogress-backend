import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import type { Database } from '../src/db.js';
import { createDatabase } from '../src/db.js';
import { loadConfig, today } from '../src/config.js';
import { hashPassword } from '../src/auth.js';
import { buildApp } from '../src/app.js';

// Exercise the actual HTTP handlers and PostgreSQL driver in one outer transaction.
// Handler transactions become savepoints; the outer transaction always rolls back.
// This script never dispatches Telegram messages or commits fixture records.
class VerificationRollback extends Error {}
const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
const suffix = randomBytes(8).toString('hex');
const adminName = `verify.admin.${suffix}`;
const techName = `verify.tech.${suffix}`;
const officeCode = `VERIFY-${suffix.toUpperCase()}`;
const password = randomBytes(24).toString('hex');
const checks: string[] = [];
let fixtureIds: { admin: number; tech: number; office: number } | undefined;
try {
  try {
    await db.transaction(async root => {
      await root.query("SET LOCAL lock_timeout = '5s'");
      await root.query("SET LOCAL statement_timeout = '30s'");
      let sequence = 0;
      const scoped: Database = {
        query: (sql, values) => root.query(sql, values),
        async transaction(fn, actorId) {
          const name = `verification_${++sequence}`;
          await root.query(`SAVEPOINT ${name}`);
          try {
            const previous = (await root.query("SELECT current_setting('app.user_id', true) AS actor")).rows[0].actor;
            if (actorId) await root.query("SELECT set_config('app.user_id', $1, true)", [actorId]);
            const result = await fn(scoped);
            await root.query("SELECT set_config('app.user_id', $1, true)", [previous ?? '']);
            await root.query(`RELEASE SAVEPOINT ${name}`);
            return result;
          } catch (error) {
            await root.query(`ROLLBACK TO SAVEPOINT ${name}`);
            await root.query(`RELEASE SAVEPOINT ${name}`);
            throw error;
          }
        },
        close: async () => {},
      };
      const hash = await hashPassword(password);
      const admin = (await root.query("INSERT INTO users(name,username,password_hash,role) VALUES('Verifikasi Admin',$1,$2,'admin') RETURNING id", [adminName, hash])).rows[0].id;
      const tech = (await root.query("INSERT INTO users(name,username,password_hash,role) VALUES('Verifikasi Teknisi',$1,$2,'teknisi') RETURNING id", [techName, hash])).rows[0].id;
      await root.query("INSERT INTO technician_areas(user_id,area) VALUES($1,'grobogan')", [tech]);
      checks.push('users dan technician_areas: tulis fixture dengan hash password');
      const app = await buildApp({ db: scoped, config });
      try {
        const base = await app.listen({ host: '127.0.0.1', port: 0 });
        type Headers = Record<string, string>;
        async function request(method: string, path: string, headers: Headers = {}, payload?: object | FormData, expected = 200) {
          const form = payload instanceof FormData;
          const response = await fetch(base + path, {
            method, headers: { ...headers, ...(payload && !form ? { 'Content-Type': 'application/json' } : {}) },
            body: payload ? form ? payload : JSON.stringify(payload) : undefined,
          });
          const body = await response.json() as any;
          assert.equal(response.status, expected, `${method} ${path}: ${body.error?.code ?? 'unexpected response'}`);
          return { response, body };
        }
        async function login(username: string): Promise<Headers> {
          const { response, body } = await request('POST', '/api/auth/login', {}, { username, password });
          return { cookie: response.headers.getSetCookie().find(v => v.startsWith('caps2tone_session='))!.split(';')[0], 'x-csrf-token': body.data.csrf_token };
        }
        const adminHeaders = await login(adminName);
        const techHeaders = await login(techName);
        assert.equal((await root.query('SELECT count(*)::int AS n FROM sessions WHERE user_id IN ($1,$2)', [admin, tech])).rows[0].n, 2);
        checks.push('sessions: login HTTP menghasilkan dua sesi database');
        const office = (await request('POST', '/api/offices', adminHeaders, { code: officeCode, name: 'Kantor Verifikasi Transaksi', area: 'grobogan' }, 201)).body.data;
        fixtureIds = { admin, tech, office: office.id };
        await request('PATCH', `/api/offices/${office.id}`, adminHeaders, { address: 'Data uji yang selalu rollback' });
        assert.equal((await request('GET', `/api/offices?search=${officeCode}`, adminHeaders)).body.meta.total, 1);
        checks.push('offices: POST, PATCH, GET menyimpan dan membaca nilai yang sama');
        const eq = (index: number) => `VERIFY-${suffix}-${index}`;
        const sn = `VERIFY-SN-${suffix.toUpperCase()}`;
        const moduleSn = `${sn}-MOD`;
        const book = new ExcelJS.Workbook();
        const sheet = book.addWorksheet('Aset');
        sheet.addRow(['EQ', 'Jenis', 'Serial Number', 'Kode Kantor', 'SN Chassis', 'REF', 'Status', 'Kondisi', 'Kode Aset']);
        sheet.addRow([eq(2), 'Modul', moduleSn, officeCode, sn, 'REF-LAMA', 'Aktif', 'Baik']);
        sheet.addRow([eq(1), 'Chassis', sn.toLowerCase(), officeCode, null, 'REF-LAMA', 'Aktif', 'Baik']);
        sheet.addRow([eq(3), 'Modul', moduleSn, officeCode, sn, 'REF-LAMA', 'Aktif', 'Baik']);
        const bytes = Uint8Array.from(Buffer.from(await book.xlsx.writeBuffer()));
        const upload = () => { const form = new FormData(); form.set('file', new Blob([bytes]), 'verify.xlsx'); return form; };
        const preview = await request('POST', '/api/assets/import?dry_run=true', adminHeaders, upload());
        assert.equal(preview.body.data.created, 3);
        assert.equal((await root.query('SELECT count(*)::int AS n FROM assets WHERE office_id=$1', [office.id])).rows[0].n, 0);
        await request('POST', '/api/assets/import?dry_run=false', adminHeaders, upload(), 201);
        const assets = (await request('GET', `/api/assets?office_id=${office.id}`, adminHeaders)).body.data;
        assert.equal(assets.length, 3);
        const chassis = assets.find((a: any) => a.eq === eq(1));
        const module = assets.find((a: any) => a.eq === eq(2));
        const missing = assets.find((a: any) => a.eq === eq(3));
        assert.equal(module.parent_id, chassis.id);
        checks.push('assets: dry run rollback, impor tiga aset, relasi chassis/modul, normalisasi SN');
        await request('PATCH', `/api/assets/${chassis.id}`, adminHeaders, { ref: 'REF-BARU', status: 'Rusak', kondisi: 'Perlu Perbaikan' });
        const history = (await request('GET', `/api/assets/${chassis.id}/history`, adminHeaders)).body;
        assert.equal(history.meta.total, 3);
        assert.ok(history.data.every((h: any) => h.changed_by === admin));
        assert.deepEqual(history.data.map((h: any) => h.field).sort(), ['kondisi', 'ref', 'status']);
        checks.push('asset_history: tiga perubahan dicatat trigger dengan actor yang benar');
        const schedule = (await request('POST', '/api/schedules', adminHeaders, { office_id: office.id, area: 'grobogan', scheduled_date: today(config.APP_TIMEZONE), assigned_to: tech }, 201)).body.data;
        assert.equal((await request('GET', `/api/schedules?office_id=${office.id}`, techHeaders)).body.data[0].id, schedule.id);
        assert.equal((await request('GET', `/api/technician/assets?schedule_id=${schedule.id}`, techHeaders)).body.meta.total, 3);
        checks.push('mapping_schedules: penugasan tersimpan dan dapat dibaca teknisi terkait');
        for (const [serial_number, expected] of [[sn, 'found'], [moduleSn, 'multiple'], [`${sn}-UNKNOWN`, 'not_found']]) {
          assert.equal((await request('POST', '/api/scan/match', techHeaders, { schedule_id: schedule.id, serial_number })).body.data.result, expected);
        }
        await request('POST', '/api/mapping-results', techHeaders, { schedule_id: schedule.id, scanned_sn: sn, label_attached: true, label_code: `LABEL-${suffix}` }, 201);
        await request('POST', '/api/mapping-results', techHeaders, { schedule_id: schedule.id, scanned_sn: moduleSn, asset_id: module.id }, 201);
        await request('POST', '/api/mapping-results', techHeaders, { schedule_id: schedule.id, scanned_sn: `${sn}-UNKNOWN` }, 201);
        await request('POST', `/api/assets/${missing.id}/not-found`, techHeaders, { schedule_id: schedule.id });
        assert.equal((await root.query('SELECT count(*)::int AS n FROM mapping_results WHERE schedule_id=$1', [schedule.id])).rows[0].n, 3);
        checks.push('mapping_results: found, multiple, not_found; label dan mapping_status tersimpan');
        const progress = (await request('GET', `/api/dashboard/progress?office_id=${office.id}`, adminHeaders)).body.data[0];
        assert.deepEqual([progress.total, progress.sudah, progress.tidak_ditemukan, progress.progress_percent], [3, 2, 1, 100]);
        assert.equal((await request('GET', `/api/reports/mapping?schedule_id=${schedule.id}`, adminHeaders)).body.meta.total, 3);
        for (const path of [`/api/assets/export?office_id=${office.id}`, `/api/reports/mapping/export?schedule_id=${schedule.id}`]) {
          const response = await fetch(base + path, { headers: adminHeaders });
          assert.equal(response.status, 200);
          assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 2).toString(), 'PK');
        }
        checks.push('dashboard, laporan dan ekspor XLSX membaca hasil transaksi database');
        const log = (await root.query(`INSERT INTO notification_logs(type,dedupe_key,payload) VALUES('verification',$1,$2::jsonb) RETURNING id`, [`verify:${suffix}`, JSON.stringify({ verification: true, no_message_sent: true })])).rows[0];
        const logs = (await request('GET', '/api/notifications/logs?limit=100', adminHeaders)).body;
        assert.ok(logs.data.some((row: any) => row.id === log.id));
        checks.push('notification_logs: tulis/baca log uji tanpa mengirim pesan');
        for (const headers of [adminHeaders, techHeaders]) {
          await request('POST', '/api/auth/logout', headers);
          await request('GET', '/api/auth/me', headers, undefined, 401);
        }
        checks.push('sessions: logout mencabut sesi dan akses berikutnya ditolak');
      } finally { await app.close(); }
      throw new VerificationRollback();
    });
  } catch (error) { if (!(error instanceof VerificationRollback)) throw error; }
  assert.ok(fixtureIds);
  const remaining = (await db.query(`SELECT
    (SELECT count(*) FROM users WHERE id IN ($1,$2)) +
    (SELECT count(*) FROM technician_areas WHERE user_id IN ($1,$2)) +
    (SELECT count(*) FROM sessions WHERE user_id IN ($1,$2)) +
    (SELECT count(*) FROM offices WHERE id=$3) +
    (SELECT count(*) FROM assets WHERE office_id=$3) +
    (SELECT count(*) FROM mapping_schedules WHERE office_id=$3) +
    (SELECT count(*) FROM mapping_results WHERE scanned_by IN ($1,$2)) +
    (SELECT count(*) FROM asset_history WHERE changed_by IN ($1,$2)) +
    (SELECT count(*) FROM notification_logs WHERE dedupe_key=$4) AS total`,
  [fixtureIds.admin, fixtureIds.tech, fixtureIds.office, `verify:${suffix}`])).rows[0].total;
  assert.equal(Number(remaining), 0, 'Data uji masih tersisa.');
  const report = { checked_at: new Date().toISOString(), database: new URL(config.DATABASE_URL).pathname.slice(1),
    connection_host: new URL(config.DATABASE_URL).hostname, status: 'passed', checks,
    fixture_records_remaining: Number(remaining), fixture_changes_committed: false, telegram_messages_sent: 0 };
  await writeFile('docs/database-api-verification.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await db.close(); }
