import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';

// f.asset = chassis EQ-001 / SN-001 di kantor jadwal. Dua modul di bawahnya, satu modul lepas, dan satu modul ber-SN sama dengan chassis.
async function setup() {
  const f = await fixture();
  const tech = await f.login('teknisi'); const admin = await f.login();
  const add = async (eq: string, sn: string, parent: number | null) => (await f.db.query(
    "INSERT INTO assets(eq,kind,serial_number,office_id,parent_id) VALUES($1,'module',$2,$3,$4) RETURNING id", [eq, sn, f.office, parent])).rows[0].id as number;
  const m1 = await add('EQ-M1', 'SN-M1', f.asset); const m2 = await add('EQ-M2', 'SN-M2', f.asset);
  const loose = await add('EQ-LOOSE', 'SN-LOOSE', null); const twin = await add('EQ-TWIN', 'SN-001', f.asset);
  const post = (path: string, body: object) => f.app.inject({ method: 'POST', url: path, headers: tech, payload: { schedule_id: f.schedule, ...body } });
  const status = async (id: number) => (await f.db.query('SELECT mapping_status FROM assets WHERE id=$1', [id])).rows[0].mapping_status as string;
  const scans = async () => Number((await f.db.query('SELECT count(*) AS n FROM mapping_results')).rows[0].n);
  return { f, tech, admin, m1, m2, loose, twin, post, status, scans };
}

test('filter kind pada scan/match dan mapping-results memisahkan chassis dan modul ber-SN sama', async t => {
  const { f, post, twin } = await setup(); t.after(() => f.close());
  const match = async (body: object) => (await post('/api/scan/match', body)).json();

  const all = await match({ serial_number: 'sn-001' });
  assert.equal(all.data.result, 'multiple'); assert.deepEqual(all.data.assets.map((a: any) => a.kind).sort(), ['chassis', 'module']);
  const modules = await match({ serial_number: 'SN-001', kind: 'module' });
  assert.equal(modules.data.result, 'found'); assert.equal(modules.data.assets[0].id, twin);
  const chassis = await match({ serial_number: 'SN-001', kind: 'chassis' });
  assert.equal(chassis.data.result, 'found'); assert.equal(chassis.data.assets[0].id, f.asset);
  assert.equal((await match({ serial_number: 'SN-M1', kind: 'chassis' })).data.result, 'not_found');
  assert.equal((await post('/api/scan/match', { serial_number: 'SN-001', kind: 'router' })).statusCode, 422);

  // Tanpa kind tetap multiple dan aset tidak diubah; dengan kind=chassis jadi found dan chassis terverifikasi.
  const ambiguous = await post('/api/mapping-results', { scanned_sn: 'SN-001' });
  assert.equal(ambiguous.statusCode, 201); assert.equal(ambiguous.json().data.result, 'multiple'); assert.equal(ambiguous.json().data.asset_id, null);
  const scan = await post('/api/mapping-results', { scanned_sn: 'SN-001', kind: 'chassis' });
  assert.equal(scan.statusCode, 201, scan.body); assert.equal(scan.json().data.result, 'found'); assert.equal(scan.json().data.asset_id, f.asset);
  assert.equal((await post('/api/mapping-results', { scanned_sn: 'SN-001', kind: 'tablet' })).statusCode, 422);
});

test('modul baru bisa dipetakan setelah chassis induknya terverifikasi', async t => {
  const { f, admin, m1, m2, loose, post, status, scans } = await setup(); t.after(() => f.close());

  // Chassis belum sudah: scan dan penandaan tidak ditemukan untuk modulnya ditolak, tanpa catatan scan.
  const blocked = await post('/api/mapping-results', { scanned_sn: 'SN-M1' });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().error.code, 'CHASSIS_NOT_VERIFIED'); assert.match(blocked.json().error.message, /EQ-001/);
  assert.deepEqual(blocked.json().error.details, { chassis_id: f.asset, chassis_eq: 'EQ-001', chassis_mapping_status: 'belum' });
  assert.equal((await post('/api/mapping-results', { scanned_sn: 'SN-M1', asset_id: m1, kind: 'module' })).statusCode, 409);
  assert.equal((await post(`/api/assets/${m1}/not-found`, {})).statusCode, 409);
  assert.equal(await scans(), 0); assert.equal(await status(m1), 'belum');

  // Modul lepas (tanpa induk) tidak terkena aturan; SN tak dikenal tetap tercatat.
  assert.equal((await post('/api/mapping-results', { scanned_sn: 'SN-LOOSE' })).statusCode, 201);
  assert.equal(await status(loose), 'sudah');
  assert.equal((await post('/api/mapping-results', { scanned_sn: 'TIDAK-ADA' })).statusCode, 201);

  // SN chassis dengan asset_id modul ditolak (SN tidak cocok), lalu chassis diverifikasi.
  assert.equal((await post('/api/mapping-results', { scanned_sn: 'SN-001', kind: 'chassis', asset_id: m1 })).statusCode, 422);
  assert.equal((await post('/api/mapping-results', { scanned_sn: 'SN-001', kind: 'chassis', asset_id: f.asset })).statusCode, 201);
  assert.equal(await status(f.asset), 'sudah');

  // Sekarang modul boleh dipindai dan ditandai tidak ditemukan.
  assert.equal((await post('/api/mapping-results', { scanned_sn: 'SN-M1' })).statusCode, 201); assert.equal(await status(m1), 'sudah');
  assert.equal((await post(`/api/assets/${m2}/not-found`, {})).statusCode, 200); assert.equal(await status(m2), 'tidak_ditemukan');

  // Admin menolak chassis: modul yang belum dipetakan kembali terkunci; yang sudah tetap sudah.
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/assets/${f.asset}/reject`, headers: admin, payload: { reason: 'Foto buram' } })).statusCode, 200);
  assert.equal((await post('/api/mapping-results', { scanned_sn: 'SN-M2' })).statusCode, 409);
  assert.equal(await status(m1), 'sudah');
  assert.equal((await post('/api/mapping-results', { scanned_sn: 'SN-001', kind: 'chassis' })).statusCode, 201);
  assert.equal((await post('/api/mapping-results', { scanned_sn: 'SN-M2' })).statusCode, 201);
});

test('chassis yang ditandai tidak ditemukan tetap mengunci modulnya', async t => {
  const { f, m1, post, status } = await setup(); t.after(() => f.close());
  assert.equal((await post(`/api/assets/${f.asset}/not-found`, {})).statusCode, 200);
  assert.equal(await status(f.asset), 'tidak_ditemukan');
  const res = await post('/api/mapping-results', { scanned_sn: 'SN-M1' });
  assert.equal(res.statusCode, 409); assert.equal(res.json().error.details.chassis_mapping_status, 'tidak_ditemukan');
  assert.equal(await status(m1), 'belum');
});
