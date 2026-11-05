import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, excel, multipartFile, missingId } from './helpers.js';
import { importAssets, readExcel } from '../src/services/excel.js';
import { loadConfig, today } from '../src/config.js';
import { hashPassword, verifyPassword } from '../src/auth.js';

test('password hash dan tanggal zona waktu', async () => {
  const hash = await hashPassword('password-panjang');
  assert.notEqual(hash, 'password-panjang');
  assert.equal(await verifyPassword('password-panjang', hash), true);
  assert.equal(await verifyPassword('salah', hash), false);
  assert.equal(today('Asia/Jakarta', new Date('2026-11-04T18:00:00Z')), '2026-11-05');
  assert.throws(() => loadConfig({ DATABASE_URL: 'x', AUTH_SECRET: 'short' }));
  assert.throws(() => loadConfig({ DATABASE_URL: 'x', AUTH_SECRET: 'x'.repeat(32), NODE_ENV: 'production' }));
});
test('sesi, cookie, CSRF, role, origin, expiry dan logout', async t => {
  const f = await fixture(); t.after(() => f.close());
  assert.equal((await f.app.inject('/api/assets')).statusCode, 401);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'wrong' } })).statusCode, 401);
  const response = await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: ' ADMIN ', password: 'caps2tone-test-password' } });
  assert.match(String(response.headers['set-cookie']), /HttpOnly/);
  assert.match(String(response.headers['set-cookie']), /SameSite=Lax/);
  assert.equal(response.json().data.user.password_hash, undefined);
  const admin = await f.login(); const tech = await f.login('teknisi');
  assert.equal((await f.app.inject({ url: '/api/auth/me', headers: admin })).statusCode, 200);
  assert.equal((await f.app.inject({ url: '/api/assets', headers: tech })).statusCode, 403);
  assert.equal((await f.app.inject({ method: 'PATCH', url: `/api/assets/${f.asset}`, headers: { cookie: admin.cookie }, payload: { ref: 'NEW' } })).statusCode, 403);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://evil.example' }, payload: { username: 'admin', password: 'caps2tone-test-password' } })).statusCode, 403);
  const logout = await f.app.inject({ method: 'POST', url: '/api/auth/logout', headers: admin });
  assert.equal(logout.statusCode, 200);
  assert.equal((await f.app.inject({ url: '/api/auth/me', headers: admin })).statusCode, 401);
  await f.db.query("UPDATE sessions SET expires_at=now()-interval '1 hour'");
  assert.equal((await f.app.inject({ url: '/api/auth/me', headers: tech })).statusCode, 401);
});
test('API aset: pencarian, pagination, audit atomik dan scope teknisi', async t => {
  const f = await fixture(); t.after(() => f.close()); const admin = await f.login(); const tech = await f.login('teknisi');
  const list = await f.app.inject({ url: '/api/assets?search=sn-001&limit=1', headers: admin });
  assert.equal(list.statusCode, 200, list.body); assert.equal(list.json().meta.total, 1);
  assert.equal((await f.app.inject({ url: '/api/assets?limit=10000', headers: admin })).statusCode, 422);
  assert.equal((await f.app.inject({ url: '/api/assets?search=%27%20OR%201%3D1--', headers: admin })).json().meta.total, 0);
  let patch = await f.app.inject({ method: 'PATCH', url: `/api/assets/${f.asset}`, headers: admin, payload: { ref: 'NEW', status: 'Rusak', kondisi: 'Baik' } });
  assert.equal(patch.statusCode, 200, patch.body);
  let history = await f.app.inject({ url: `/api/assets/${f.asset}/history`, headers: admin });
  assert.equal(history.json().meta.total, 3);
  assert.ok(history.json().data.every((row: any) => row.changed_by === f.admin));
  patch = await f.app.inject({ method: 'PATCH', url: `/api/assets/${f.asset}`, headers: admin, payload: { ref: 'NEW' } });
  assert.equal(patch.statusCode, 200);
  history = await f.app.inject({ url: `/api/assets/${f.asset}/history`, headers: admin }); assert.equal(history.json().meta.total, 3);
  await assert.rejects(f.db.query("UPDATE assets SET ref='BYPASS' WHERE id=$1", [f.asset]));
  assert.equal((await f.db.query('SELECT ref FROM assets WHERE id=$1', [f.asset])).rows[0].ref, 'NEW');
  assert.equal((await f.app.inject({ method: 'PATCH', url: `/api/assets/${f.asset}`, headers: tech, payload: { kondisi: 'Rusak', schedule_id: f.schedule } })).statusCode, 403);
  assert.equal((await f.app.inject({ method: 'PATCH', url: `/api/assets/${f.otherAsset}`, headers: tech, payload: { ref: 'X', schedule_id: f.schedule } })).statusCode, 403);
  assert.equal((await f.app.inject({ method: 'PATCH', url: `/api/assets/${f.asset}`, headers: tech, payload: { ref: 'TEKNISI', schedule_id: f.schedule } })).statusCode, 200);
  const own = await f.app.inject({ url: `/api/technician/assets?schedule_id=${f.schedule}`, headers: tech });
  assert.equal(own.statusCode, 200, own.body); assert.equal(own.json().meta.total, 1);
  assert.equal((await f.app.inject({ url: `/api/technician/assets?schedule_id=${f.schedule}`, headers: await f.login('lain') })).statusCode, 403);
});
test('scan found / not_found / multiple, label, hasil append-only dan progres', async t => {
  const f = await fixture(); t.after(() => f.close()); const tech = await f.login('teknisi'); const admin = await f.login();
  const match = (serial_number: string) => f.app.inject({ method: 'POST', url: '/api/scan/match', headers: tech, payload: { serial_number, schedule_id: f.schedule } });
  assert.equal((await match(' sn-001 ')).json().data.result, 'found');
  assert.equal((await match('SN-OTHER')).json().data.result, 'not_found');
  const scan = (body: object) => f.app.inject({ method: 'POST', url: '/api/mapping-results', headers: tech, payload: { schedule_id: f.schedule, scanned_sn: 'SN-001', ...body } });
  let response = await scan({ label_attached: true, label_code: 'LABEL-001' }); assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().data.result, 'found');
  assert.equal((await scan({})).statusCode, 201);
  response = await scan({ scanned_sn: 'UNKNOWN' }); assert.equal(response.json().data.result, 'not_found'); assert.equal(response.json().data.asset_id, null);
  assert.equal((await scan({ scanned_sn: 'UNKNOWN', label_attached: true })).statusCode, 422);
  assert.equal((await scan({ asset_id: f.otherAsset })).statusCode, 422);
  const duplicate = (await f.db.query("INSERT INTO assets(eq,kind,serial_number,office_id) VALUES('EQ-002','module','SN-001',$1) RETURNING id", [f.office])).rows[0].id;
  assert.equal((await match('SN-001')).json().data.result, 'multiple');
  response = await scan({}); assert.equal(response.json().data.result, 'multiple'); assert.equal(response.json().data.asset_id, null);
  response = await scan({ asset_id: duplicate }); assert.equal(response.json().data.result, 'multiple'); assert.equal(response.json().data.asset_id, duplicate);
  assert.equal((await f.db.query('SELECT count(*) AS n FROM mapping_results')).rows[0].n, 5);
  assert.equal((await f.db.query('SELECT label_status,label_code FROM assets WHERE id=$1', [f.asset])).rows[0].label_status, 'terpasang');
  const progress = await f.app.inject({ url: `/api/dashboard/progress?office_id=${f.office}`, headers: admin });
  assert.equal(progress.statusCode, 200, progress.body); assert.equal(progress.json().data[0].sudah, 2); assert.equal(progress.json().data[0].progress_percent, 100);
  const report = await f.app.inject({ url: `/api/reports/mapping?schedule_id=${f.schedule}`, headers: admin }); assert.equal(report.statusCode, 200, report.body); assert.equal(report.json().meta.total, 5);
  assert.equal((await f.app.inject({ method: 'PATCH', url: `/api/schedules/${f.schedule}`, headers: admin, payload: { office_id: f.otherOffice, area: 'solo' } })).statusCode, 409);
  await f.db.query("UPDATE mapping_schedules SET status='selesai' WHERE id=$1", [f.schedule]);
  assert.equal((await scan({})).statusCode, 409);
});
test('jadwal: tanggal, role, area, constraint duplikasi dan pembatalan', async t => {
  const f = await fixture(); t.after(() => f.close()); const admin = await f.login(); const tech = await f.login('teknisi');
  const payload = { office_id: f.office, area: 'grobogan', scheduled_date: f.day, assigned_to: f.tech };
  const create = (patch: object = {}, headers = admin) => f.app.inject({ method: 'POST', url: '/api/schedules', headers, payload: { ...payload, ...patch } });
  assert.equal((await create()).statusCode, 409);
  assert.equal((await create({}, tech)).statusCode, 403);
  assert.equal((await create({ scheduled_date: '2000-01-01' })).statusCode, 422);
  assert.equal((await create({ scheduled_date: '2027-02-30' })).statusCode, 422);
  assert.equal((await create({ area: 'solo' })).statusCode, 422);
  assert.equal((await create({ assigned_to: f.other })).statusCode, 422);
  assert.equal((await create({ assigned_to: f.admin })).statusCode, 422);
  const own = await f.app.inject({ url: '/api/schedules', headers: tech }); assert.equal(own.json().meta.total, 1);
  assert.equal((await f.app.inject({ url: '/api/schedules', headers: await f.login('lain') })).json().meta.total, 0);
  assert.equal((await f.app.inject({ url: `/api/schedules?assigned_to=${f.other}`, headers: tech })).statusCode, 403);
  assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/schedules?id=${f.schedule}`, headers: admin })).statusCode, 200);
  assert.equal((await create({ assigned_to: null })).statusCode, 201);
  assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/schedules/${missingId()}`, headers: admin })).statusCode, 404);
  await assert.rejects(f.db.query("INSERT INTO mapping_schedules(office_id,area,scheduled_date,created_by) VALUES($1,'grobogan',$2,$3)", [f.office, f.day, f.admin]));
});
test('impor Excel: dry run rollback, upsert audit, hubungan induk dan kegagalan atomik', async t => {
  const f = await fixture(); t.after(() => f.close());
  const file = await excel([
    ['EQ-MOD', 'Modul', 'sn-mod', 'KTR-GRB', 'sn-001', null, 'Aktif', 'Baik'],
    ['EQ-001', 'Chassis', 'sn-001', 'KTR-GRB', null, 'IMPORTED', 'Rusak'],
  ]);
  const preview: any = await importAssets(f.db, file, f.admin, true);
  assert.deepEqual(preview, { dry_run: true, created: 1, updated: 1, total: 2 });
  assert.equal((await f.db.query('SELECT count(*) AS n FROM assets')).rows[0].n, 2);
  assert.equal((await f.db.query('SELECT count(*) AS n FROM asset_history')).rows[0].n, 0);
  await importAssets(f.db, file, f.admin, false);
  assert.equal((await f.db.query("SELECT parent_id FROM assets WHERE eq='EQ-MOD'")).rows[0].parent_id, f.asset);
  assert.equal((await f.db.query('SELECT count(*) AS n FROM asset_history')).rows[0].n, 2);
  const bad = await excel([
    ['EQ-001', 'Chassis', 'SN-001', 'KTR-GRB', null, 'MUST ROLLBACK'],
    ['EQ-BAD', 'Modul', 'SN-BAD', 'KTR-GRB', 'NO-PARENT'],
  ]);
  await assert.rejects(importAssets(f.db, bad, f.admin, false), (e: any) => e.code === 'IMPORT_VALIDATION' && e.details[0].row === 3);
  assert.equal((await f.db.query('SELECT ref FROM assets WHERE id=$1', [f.asset])).rows[0].ref, 'IMPORTED');
  const duplicate = await excel([['EQ-X', 'Chassis', 'SN-X', 'KTR-GRB'], ['EQ-X', 'Chassis', 'SN-Y', 'KTR-GRB']]);
  await assert.rejects(readExcel(duplicate), (e: any) => e.details[0].row === 3);
  const unknownOffice = await excel([['EQ-X', 'Chassis', 'SN-X', 'BAD']]);
  await assert.rejects(importAssets(f.db, unknownOffice, f.admin, false));
  const formula = await excel([['EQ-X', 'Chassis', { formula: '1+1' }, 'KTR-GRB']]);
  await assert.rejects(readExcel(formula));
  await assert.rejects(readExcel(Buffer.from('not an excel')));
});
test('HTTP multipart impor, admin only dan ekspor XLSX/laporan', async t => {
  const f = await fixture(); t.after(() => f.close()); const admin = await f.login();
  const file = multipartFile(await excel([['EQ-NEW', 'Chassis', 'SN-NEW', 'KTR-GRB']]));
  const response = await f.app.inject({ method: 'POST', url: '/api/assets/import', headers: { ...admin, ...file.headers }, payload: file.payload });
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().data.dry_run, true);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/assets/import?dry_run=false', headers: { ...admin, ...file.headers }, payload: file.payload })).statusCode, 201);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/assets/import', headers: { ...await f.login('teknisi'), ...file.headers }, payload: file.payload })).statusCode, 403);
  const exported = await f.app.inject({ url: '/api/assets/export?search=EQ-NEW', headers: admin });
  assert.equal(exported.statusCode, 200, exported.body); assert.ok(exported.rawPayload.subarray(0, 2).equals(Buffer.from('PK')));
  const report = await f.app.inject({ url: '/api/reports/mapping/export', headers: admin }); assert.equal(report.statusCode, 200);
  assert.equal((await f.app.inject({ url: '/api/reports/mapping', headers: await f.login('teknisi') })).statusCode, 403);
});
test('cron secret, deduplikasi, logs, mode per teknisi dan retry kegagalan', async t => {
  let fail = false; const sent: string[] = [];
  const f = await fixture({ TELEGRAM_RECIPIENT_MODE: 'technician' }, async (chat, text) => { if (fail) throw new Error('network'); sent.push(`${chat}:${text}`); }); t.after(() => f.close());
  const headers = { authorization: `Bearer ${f.config.CRON_SECRET}` };
  assert.equal((await f.app.inject('/api/cron/notify-schedule')).statusCode, 401);
  let response = await f.app.inject({ url: '/api/cron/notify-schedule', headers }); assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().data.sent, 1); assert.match(sent[0], /^12345:/);
  response = await f.app.inject({ url: '/api/cron/notify-schedule', headers }); assert.equal(response.json().data.skipped, 1); assert.equal(sent.length, 1);
  fail = true;
  response = await f.app.inject({ url: '/api/cron/notify-results', headers }); assert.equal(response.statusCode, 502, response.body);
  const failedLog=(await f.db.query("SELECT success,sent_at FROM notification_logs WHERE type='results'")).rows[0];
  assert.equal(failedLog.success,false);assert.equal(failedLog.sent_at,null);
  await f.db.query("UPDATE notification_logs SET attempted_at=now()-interval '16 minutes' WHERE type='results'");
  fail = false;
  response = await f.app.inject({ url: '/api/cron/notify-results', headers }); assert.equal(response.json().data.sent, 1);
  const logs = await f.app.inject({ url: '/api/notifications/logs', headers: await f.login() }); assert.equal(logs.json().meta.total, 2);
  await f.db.query('UPDATE users SET telegram_chat_id=NULL WHERE id=$1', [f.tech]);
  assert.equal((await f.app.inject({ url: '/api/cron/notify-results', headers })).statusCode, 503);
});
