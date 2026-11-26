import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const office = async (f: Fixture, code: string, name: string, area = 'grobogan') =>
  (await f.db.query('INSERT INTO offices(code,name,area) VALUES($1,$2,$3) RETURNING id', [code, name, area])).rows[0].id as number;
const schedule = async (f: Fixture, officeId: number, date: string, status: string, assignedTo: number | null, area = 'grobogan') =>
  (await f.db.query('INSERT INTO mapping_schedules(office_id,area,scheduled_date,assigned_to,status,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
    [officeId, area, date, assignedTo, status, f.admin])).rows[0].id as number;
const module = async (f: Fixture, eq: string, sn: string, parent: number | null, status = 'belum', officeId = f.office) =>
  (await f.db.query("INSERT INTO assets(eq,kind,serial_number,office_id,parent_id,mapping_status) VALUES($1,'module',$2,$3,$4,$5) RETURNING id", [eq, sn, officeId, parent, status])).rows[0].id as number;

test('GET /api/technician/offices: kantor, jadwal yang dipakai, can_scan, dan jumlah aset', async t => {
  const f = await fixture(); t.after(() => f.close());
  const tech = await f.login('teknisi'); const admin = await f.login(); const other = await f.login('lain');
  const get = async (headers: object) => f.app.inject({ url: '/api/technician/offices', headers: headers as any });

  // Aset kantor jadwal hari ini: chassis belum + modul sudah, tidak ditemukan, dan belum.
  await module(f, 'EQ-M1', 'SN-M1', f.asset, 'sudah'); await module(f, 'EQ-M2', 'SN-M2', f.asset, 'tidak_ditemukan'); await module(f, 'EQ-M3', 'SN-M3', f.asset, 'belum');
  // Jadwal lampau selesai di kantor yang sama tidak mengalahkan jadwal aktif hari ini.
  await schedule(f, f.office, '2000-01-01', 'selesai', f.tech);
  // Kantor lain: hanya jadwal lampau; hanya jadwal dibatalkan; jadwal masa depan.
  const past = await office(f, 'KTR-PAST', 'Alfa'); const pastSchedule = await schedule(f, past, '2000-01-02', 'selesai', f.tech);
  const cancelled = await office(f, 'KTR-CNL', 'Bravo'); await schedule(f, cancelled, '2099-01-01', 'dibatalkan', f.tech);
  const future = await office(f, 'KTR-FUT', 'Charlie'); const futureSchedule = await schedule(f, future, '2099-01-01', 'terjadwal', null);
  // Kantor Solo tanpa penugasan: tidak terlihat oleh teknisi yang hanya melayani Grobogan.
  const solo = await office(f, 'KTR-SOLO2', 'Delta', 'solo'); await schedule(f, solo, f.day, 'terjadwal', null, 'solo');

  const res = await get(tech); assert.equal(res.statusCode, 200, res.body);
  const rows = res.json().data;
  assert.deepEqual(rows.map((r: any) => r.name), ['Grobogan', 'Alfa', 'Charlie']);
  const [today, past1, fut] = rows;
  assert.deepEqual({ id: today.id, schedule_id: today.schedule_id, can_scan: today.can_scan, schedule_status: today.schedule_status, date: today.scheduled_date }, { id: f.office, schedule_id: f.schedule, can_scan: true, schedule_status: 'terjadwal', date: f.day });
  assert.deepEqual({ chassis: today.chassis, modules: today.modules, total: today.total, sudah: today.sudah, belum: today.belum, tidak_ditemukan: today.tidak_ditemukan },
    { chassis: 1, modules: 3, total: 4, sudah: 1, belum: 2, tidak_ditemukan: 1 });
  assert.deepEqual({ s: today.module_sudah, b: today.module_belum, n: today.module_tidak_ditemukan }, { s: 1, b: 1, n: 1 });
  assert.deepEqual({ id: past1.id, schedule_id: past1.schedule_id, can_scan: past1.can_scan, date: past1.scheduled_date, total: past1.total }, { id: past, schedule_id: pastSchedule, can_scan: false, date: '2000-01-02', total: 0 });
  assert.deepEqual({ id: fut.id, schedule_id: fut.schedule_id, can_scan: fut.can_scan, date: fut.scheduled_date }, { id: future, schedule_id: futureSchedule, can_scan: false, date: '2099-01-01' });
  assert.ok(!rows.some((r: any) => r.id === cancelled || r.id === solo));
  assert.deepEqual(Object.keys(today).sort(), ['address', 'area', 'belum', 'can_scan', 'chassis', 'code', 'id', 'module_belum', 'module_sudah', 'module_tidak_ditemukan', 'modules', 'name',
    'schedule_id', 'schedule_status', 'scheduled_date', 'sudah', 'tidak_ditemukan', 'total']);

  // Teknisi Solo melihat kantor Solo tanpa penugasan, bukan kantor Grobogan.
  assert.deepEqual((await get(other)).json().data.map((r: any) => r.name), ['Delta']);
  assert.equal((await get(admin)).statusCode, 403);
  assert.equal((await f.app.inject({ url: '/api/technician/offices' })).statusCode, 401);

  // schedule_id yang dikembalikan benar-benar dapat dipakai untuk membuka aset kantor itu.
  const assets = await f.app.inject({ url: `/api/technician/assets?schedule_id=${today.schedule_id}`, headers: tech });
  assert.equal(assets.json().meta.total, 4);
});

test('POST /api/assets/:id/reset membatalkan tanda tidak ditemukan', async t => {
  const f = await fixture(); t.after(() => f.close());
  const tech = await f.login('teknisi'); const admin = await f.login();
  const mod = await module(f, 'EQ-M1', 'SN-M1', null);
  const post = (path: string, headers: object, body: object) => f.app.inject({ method: 'POST', url: path, headers: headers as any, payload: body });
  const status = async (id: number) => (await f.db.query('SELECT mapping_status FROM assets WHERE id=$1', [id])).rows[0].mapping_status as string;

  assert.equal((await post(`/api/assets/${mod}/reset`, tech, { schedule_id: f.schedule })).statusCode, 409);
  assert.equal((await post(`/api/assets/${mod}/not-found`, tech, { schedule_id: f.schedule })).statusCode, 200); assert.equal(await status(mod), 'tidak_ditemukan');
  const reset = await post(`/api/assets/${mod}/reset`, tech, { schedule_id: f.schedule });
  assert.equal(reset.statusCode, 200, reset.body); assert.equal(reset.json().data.mapping_status, 'belum'); assert.equal(await status(mod), 'belum');
  const again = await post(`/api/assets/${mod}/reset`, tech, { schedule_id: f.schedule });
  assert.equal(again.statusCode, 409); assert.equal(again.json().error.code, 'NOT_MARKED');

  // Aset di kantor lain, jadwal tidak aktif, peran admin, dan body salah.
  await f.db.query("UPDATE assets SET mapping_status='tidak_ditemukan' WHERE id=$1", [f.otherAsset]);
  assert.equal((await post(`/api/assets/${f.otherAsset}/reset`, tech, { schedule_id: f.schedule })).statusCode, 403);
  const past = await schedule(f, f.office, '2000-01-01', 'terjadwal', f.tech);
  assert.equal((await post(`/api/assets/${mod}/reset`, tech, { schedule_id: past })).statusCode, 409);
  assert.equal((await post(`/api/assets/${mod}/reset`, admin, { schedule_id: f.schedule })).statusCode, 403);
  assert.equal((await post(`/api/assets/${mod}/reset`, tech, {})).statusCode, 422);
  assert.equal((await post('/api/assets/999999/reset', tech, { schedule_id: f.schedule })).statusCode, 404);
});

test('kode label: PATCH tanpa scan dan keunikan di PATCH maupun mapping-results', async t => {
  const f = await fixture(); t.after(() => f.close());
  const tech = await f.login('teknisi'); const admin = await f.login();
  const m1 = await module(f, 'EQ-M1', 'SN-M1', null); const m2 = await module(f, 'EQ-M2', 'SN-M2', null);
  const patch = (id: number, headers: object, body: object) => f.app.inject({ method: 'PATCH', url: `/api/assets/${id}`, headers: headers as any, payload: body });
  const row = async (id: number) => (await f.db.query('SELECT label_code,label_status FROM assets WHERE id=$1', [id])).rows[0];
  const historyBefore = Number((await f.db.query('SELECT count(*) AS n FROM asset_history')).rows[0].n);

  const set = await patch(f.asset, tech, { schedule_id: f.schedule, label_code: 'LBL-1' });
  assert.equal(set.statusCode, 200, set.body); assert.equal(set.json().data.label_code, 'LBL-1'); assert.equal(set.json().data.label_status, 'terpasang');
  assert.deepEqual({ ...await row(f.asset) }, { label_code: 'LBL-1', label_status: 'terpasang' });
  assert.equal((await patch(f.asset, tech, { schedule_id: f.schedule, label_code: 'LBL-1' })).statusCode, 200);

  const clash = await patch(m1, tech, { schedule_id: f.schedule, label_code: 'LBL-1' });
  assert.equal(clash.statusCode, 409); assert.equal(clash.json().error.code, 'LABEL_IN_USE'); assert.deepEqual({ ...await row(m1) }, { label_code: null, label_status: 'belum' });
  assert.equal((await patch(m1, admin, { label_code: 'LBL-1' })).statusCode, 409);
  assert.equal((await patch(m1, admin, { label_code: 'LBL-2' })).statusCode, 200);

  // Teknisi wajib menyertakan jadwal; kode kosong ditolak; label bisa diubah bersama REF.
  assert.equal((await patch(m2, tech, { label_code: 'LBL-3' })).statusCode, 422);
  assert.equal((await patch(m2, tech, { schedule_id: f.schedule, label_code: '   ' })).statusCode, 422);
  const both = await patch(m2, tech, { schedule_id: f.schedule, ref: 'RK-9', label_code: 'LBL-3' });
  assert.equal(both.statusCode, 200, both.body); assert.equal(both.json().data.ref, 'RK-9'); assert.equal((await row(m2)).label_code, 'LBL-3');

  // mapping-results memakai aturan yang sama dan tidak mencatat scan bila label bentrok.
  const scans = async () => Number((await f.db.query('SELECT count(*) AS n FROM mapping_results')).rows[0].n);
  const before = await scans();
  const blocked = await f.app.inject({ method: 'POST', url: '/api/mapping-results', headers: tech, payload: { schedule_id: f.schedule, scanned_sn: 'SN-M1', asset_id: m1, label_attached: true, label_code: 'LBL-3' } });
  assert.equal(blocked.statusCode, 409, blocked.body); assert.equal(blocked.json().error.code, 'LABEL_IN_USE'); assert.equal(await scans(), before);
  const free = await f.app.inject({ method: 'POST', url: '/api/mapping-results', headers: tech, payload: { schedule_id: f.schedule, scanned_sn: 'SN-M1', asset_id: m1, label_attached: true, label_code: 'LBL-2' } });
  assert.equal(free.statusCode, 201, free.body);
  // Memindai ulang dengan label milik aset itu sendiri tetap boleh.
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/mapping-results', headers: tech, payload: { schedule_id: f.schedule, scanned_sn: 'SN-M1', asset_id: m1, label_attached: true, label_code: 'LBL-2' } })).statusCode, 201);

  // Perubahan label tidak masuk riwayat REF/STATUS/KONDISI; perubahan REF masuk.
  assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM asset_history')).rows[0].n), historyBefore + 1);
});
