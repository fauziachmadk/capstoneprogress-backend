import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { fixture, missingId } from './helpers.js';
import { migrate } from '../scripts/migration-runner.js';
import { importAssets, readExcel } from '../src/services/excel.js';
import { apiContracts } from '../src/contracts.js';
import { buildApp } from '../src/app.js';

test('seluruh endpoint admin dan teknisi menolak role yang salah', async t => {
  const f = await fixture(); t.after(() => f.close());
  const tech = await f.login('teknisi'); const admin = await f.login();
  const adminOnly = apiContracts.filter(c => c.roles.startsWith('Admin.') || (c.roles.startsWith('Admin;') && !c.roles.includes('teknisi')));
  for (const contract of adminOnly) {
    const url = contract.path.replace(':id', f.asset);
    const response = await f.app.inject({ method: contract.method as any, url, headers: tech });
    assert.equal(response.statusCode, 403, `${contract.method} ${url}: ${response.body}`);
  }
  for (const contract of apiContracts.filter(c => c.roles.startsWith('Teknisi'))) {
    const response = await f.app.inject({ method: contract.method as any, url: contract.path.replace(':id', f.asset), headers: admin });
    assert.equal(response.statusCode, 403, `${contract.method} ${contract.path}`);
  }
});
test('CRUD kantor, filter pengguna, kantor penugasan dan integritas induk aset', async t => {
  const f = await fixture(); t.after(() => f.close()); const headers = await f.login();
  const create = await f.app.inject({ method: 'POST', url: '/api/offices', headers, payload: { code: ' ktr-new ', name: 'Baru', area: 'solo' } });
  assert.equal(create.statusCode, 201, create.body); const officeId = create.json().data.id;
  assert.equal(create.json().data.code, 'KTR-NEW');
  assert.equal((await f.app.inject({ method: 'PATCH', url: `/api/offices/${officeId}`, headers, payload: { address: 'Alamat baru' } })).statusCode, 200);
  assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/offices/${officeId}`, headers })).statusCode, 204);
  assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/offices/${f.office}`, headers })).statusCode, 409);
  assert.equal((await f.app.inject({ method: 'PATCH', url: `/api/offices/${f.office}`, headers, payload: { area: 'solo' } })).statusCode, 409);
  const users = await f.app.inject({ url: '/api/users?role=teknisi&area=grobogan', headers });
  assert.equal(users.statusCode, 200, users.body); assert.equal(users.json().meta.total, 1); assert.equal(users.json().data[0].password_hash, undefined);
  const offices = await f.app.inject({ url: '/api/offices', headers: await f.login('teknisi') });
  assert.equal(offices.json().meta.total, 1); assert.equal(offices.json().data[0].id, f.office);
  await assert.rejects(f.db.query("INSERT INTO assets(eq,kind,serial_number,office_id,parent_id) VALUES('BAD','module','BAD',$1,$2)", [f.otherOffice, f.asset]));
  await f.db.query("INSERT INTO assets(eq,kind,serial_number,office_id,parent_id) VALUES('GOOD','module','GOOD',$1,$2)", [f.office, f.asset]);
  await assert.rejects(f.db.query('UPDATE assets SET office_id=$1 WHERE id=$2', [f.otherOffice, f.asset]));
});
test('kebijakan kondisi dan penugasan dapat diaktifkan tanpa mengubah kode', async t => {
  const f = await fixture({ TECHNICIAN_CAN_EDIT_CONDITION: true, REQUIRE_SCHEDULE_ASSIGNEE: true }); t.after(() => f.close());
  const tech = await f.login('teknisi'); const admin = await f.login();
  const changed = await f.app.inject({ method: 'PATCH', url: `/api/assets/${f.asset}`, headers: tech, payload: { kondisi: 'Baik', schedule_id: f.schedule } });
  assert.equal(changed.statusCode, 200, changed.body);
  const history = (await f.db.query("SELECT changed_by FROM asset_history WHERE field='kondisi'")).rows;
  assert.equal(history[0].changed_by, f.tech);
  const schedule = await f.app.inject({ method: 'POST', url: '/api/schedules', headers: admin, payload: { office_id: f.otherOffice, area: 'solo', scheduled_date: f.day } });
  assert.equal(schedule.statusCode, 422); assert.equal(schedule.json().error.code, 'ASSIGNEE_REQUIRED');
});
test('aset hilang, jadwal lampau/ditutup, validasi ketat, dan ID tidak valid', async t => {
  const f = await fixture(); t.after(() => f.close()); const tech = await f.login('teknisi'); const admin = await f.login();
  let response = await f.app.inject({ method: 'POST', url: `/api/assets/${f.asset}/not-found`, headers: tech, payload: { schedule_id: f.schedule } });
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().data.mapping_status, 'tidak_ditemukan');
  response = await f.app.inject({ url: `/api/dashboard/progress?office_id=${f.office}`, headers: admin });
  assert.equal(response.json().data[0].tidak_ditemukan, 1);
  assert.equal(response.json().data[0].progress_percent, 100);
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/assets/${f.otherAsset}/not-found`, headers: tech, payload: { schedule_id: f.schedule } })).statusCode, 403);
  assert.equal((await f.app.inject({ method: 'PATCH', url: '/api/assets/not-missingId', headers: admin, payload: { ref: 'X' } })).statusCode, 422);
  assert.equal((await f.app.inject({ method: 'PATCH', url: `/api/assets/${missingId()}`, headers: admin, payload: { ref: 'X' } })).statusCode, 404);
  assert.equal((await f.app.inject({ method: 'PATCH', url: `/api/assets/${f.asset}`, headers: admin, payload: { ref: 'X', role: 'admin' } })).statusCode, 422);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/mapping-results', headers: tech, payload: { schedule_id: f.schedule, scanned_sn: 'SN-001', label_attached: 'false' } })).statusCode, 422);
  await f.db.query("UPDATE mapping_schedules SET scheduled_date='2000-01-01' WHERE id=$1", [f.schedule]);
  response = await f.app.inject({ method: 'POST', url: '/api/scan/match', headers: tech, payload: { schedule_id: f.schedule, serial_number: 'SN-001' } });
  assert.equal(response.statusCode, 409);
  assert.equal((await f.app.inject({ method: 'PATCH', url: `/api/schedules/${f.schedule}`, headers: admin, payload: { status: 'selesai' } })).statusCode, 200);
  assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/schedules/${f.schedule}`, headers: admin })).statusCode, 409);
});
test('migrasi idempotent, checksum menolak perubahan, impor mempertahankan header yang tidak disertakan', async t => {
  const f = await fixture(); t.after(() => f.close());
  await migrate(f.db);
  assert.equal((await f.db.query('SELECT count(*) AS n FROM schema_migrations')).rows[0].n, 3);
  await f.db.query("UPDATE schema_migrations SET checksum='modified'");
  await assert.rejects(migrate(f.db), /sudah berubah/);
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Aset');
  sheet.addRow(['EQ', 'Jenis', 'Serial Number', 'Kode Kantor']);
  sheet.addRow(['EQ-001', 'Chassis', 'SN-UPDATED', 'KTR-GRB']);
  await importAssets(f.db, Buffer.from(await book.xlsx.writeBuffer()), f.admin, false);
  const asset = (await f.db.query('SELECT ref,status,serial_number FROM assets WHERE id=$1', [f.asset])).rows[0];
  assert.deepEqual(asset, { ref: 'OLD', status: 'Aktif', serial_number: 'SN-UPDATED' });
  await assert.rejects(readExcel(Buffer.alloc(3 * 1024 * 1024 + 1)), (e: any) => e.statusCode === 413);
});
test('ekspor membatasi data besar dan tetap mematuhi filter', async t => {
  const f = await fixture(); t.after(() => f.close()); const headers = await f.login();
  await f.db.query(`INSERT INTO assets(eq,kind,serial_number,office_id)
    SELECT 'BULK-'||n,'chassis','BULK-SN-'||n,$1 FROM generate_series(1,10001) n`, [f.office]);
  assert.equal((await f.app.inject({ url: '/api/assets/export', headers })).statusCode, 422);
  assert.equal((await f.app.inject({ url: '/api/assets/export?search=EQ-001', headers })).statusCode, 200);
  const page = await f.app.inject({ url: '/api/assets?page=2&limit=10', headers });
  assert.equal(page.json().data.length, 10); assert.equal(page.json().meta.total, 10003);
});
test('cron paralel tidak mengirim ganda; konfigurasi hilang menghasilkan 503', async t => {
  const sent: string[] = [];
  const f = await fixture({ TELEGRAM_SUMMARY_MODE: 'office' }, async (_chat, message) => { sent.push(message); }); t.after(() => f.close());
  const options = { url: '/api/cron/notify-schedule', headers: { authorization: `Bearer ${f.config.CRON_SECRET}` } };
  const responses = await Promise.all([f.app.inject(options), f.app.inject(options)]);
  assert.ok(responses.every(r => r.statusCode === 200)); assert.equal(sent.length, 1);
  const noTelegram = await buildApp({ db: f.db, config: { ...f.config, TELEGRAM_BOT_TOKEN: undefined } }); t.after(() => noTelegram.close());
  assert.equal((await noTelegram.inject(options)).statusCode, 503);
});
test('dokumentasi kontrak tersedia, cookie produksi Secure, dan error internal tidak membocorkan detail', async t => {
  const f = await fixture({ NODE_ENV: 'production', FRONTEND_ORIGINS: 'https://frontend.example', COOKIE_SAME_SITE: 'none' }); t.after(() => f.close());
  const response = await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'caps2tone-test-password' } });
  assert.match(String(response.headers['set-cookie']), /Secure/); assert.match(String(response.headers['set-cookie']), /SameSite=None/);
  assert.equal(response.headers['cache-control'], 'no-store');
  const docs = await f.app.inject('/docs/json'); assert.equal(docs.statusCode, 200, docs.body);
  for (const contract of apiContracts) assert.ok(docs.json().paths[contract.path.replace(':id', '{id}')][contract.method.toLowerCase()]);
  assert.equal(docs.json().paths['/api/auth/login'].post.requestBody.content['application/json'].schema.required.length, 2);
  const broken = await buildApp({ db: { ...f.db, query: async () => { throw new Error('private-password-in-error'); } }, config: f.config }); t.after(() => broken.close());
  const failed = await broken.inject('/health'); assert.equal(failed.statusCode, 500); assert.ok(!failed.body.includes('private-password'));
});
