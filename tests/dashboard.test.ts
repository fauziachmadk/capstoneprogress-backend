import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';

test('progres kantor memuat jadwal terdekat, aktivitas terakhir, dan keadaan jadwal', async t => {
  const f = await fixture(); t.after(() => f.close());
  const admin = await f.login(); const tech = await f.login('teknisi');
  const office = async (id: number) => {
    const res = await f.app.inject({ url: '/api/dashboard/progress', headers: admin });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().data.find((r: any) => r.id === id);
  };

  // Jadwal hari ini masih terjadwal; kantor lain belum punya jadwal.
  let grobogan = await office(f.office); let solo = await office(f.otherOffice);
  assert.equal(grobogan.schedule_state, 'terjadwal'); assert.equal(grobogan.next_date, f.day); assert.equal(grobogan.last_activity, null);
  assert.equal(solo.schedule_state, 'belum'); assert.equal(solo.next_date, null); assert.equal(solo.last_activity, null);
  assert.equal(grobogan.percent, 0); assert.equal(grobogan.done, 0); assert.equal(grobogan.total, 1);

  // Scan pertama membuat jadwal berjalan dan mengisi aktivitas terakhir.
  const scan = await f.app.inject({ method: 'POST', url: '/api/mapping-results', headers: tech, payload: { schedule_id: f.schedule, scanned_sn: 'SN-001' } });
  assert.equal(scan.statusCode, 201, scan.body);
  grobogan = await office(f.office);
  assert.equal(grobogan.schedule_state, 'berjalan'); assert.equal(grobogan.next_date, null);
  assert.ok(Date.parse(grobogan.last_activity) > 0); assert.equal(grobogan.percent, 100);

  // Jadwal masa depan di kantor lain.
  const future = await f.app.inject({ method: 'POST', url: '/api/schedules', headers: admin, payload: { office_id: f.otherOffice, area: 'solo', scheduled_date: '2099-06-01' } });
  assert.equal(future.statusCode, 201, future.body);
  solo = await office(f.otherOffice);
  assert.equal(solo.schedule_state, 'terjadwal'); assert.equal(solo.next_date, '2099-06-01');
  // Jadwal dibatalkan tidak dihitung.
  assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/schedules/${future.json().data.id}`, headers: admin })).statusCode, 200);
  solo = await office(f.otherOffice);
  assert.equal(solo.schedule_state, 'belum'); assert.equal(solo.next_date, null);

  // Selesai.
  assert.equal((await f.app.inject({ method: 'PATCH', url: `/api/schedules/${f.schedule}`, headers: admin, payload: { status: 'selesai' } })).statusCode, 200);
  assert.equal((await office(f.office)).schedule_state, 'selesai');
});

test('ringkasan dashboard: persen dan hasil hari ini', async t => {
  const f = await fixture(); t.after(() => f.close());
  const admin = await f.login(); const tech = await f.login('teknisi');
  const summary = async () => (await f.app.inject({ url: '/api/dashboard/summary', headers: admin })).json().data;

  let s = await summary();
  assert.deepEqual(s, { total: 2, sudah: 0, belum: 2, tidak_ditemukan: 0, percent: 0,
    today: { found: 0, not_found: 0, multiple: 0, ref_changes: 0, status_changes: 0 } });

  const scan = (scanned_sn: string) => f.app.inject({ method: 'POST', url: '/api/mapping-results', headers: tech, payload: { schedule_id: f.schedule, scanned_sn } });
  assert.equal((await scan('SN-001')).statusCode, 201);
  assert.equal((await scan('SN-TIDAK-ADA')).statusCode, 201);
  const edit = await f.app.inject({ method: 'PATCH', url: `/api/assets/${f.asset}`, headers: tech, payload: { schedule_id: f.schedule, ref: 'RK-9', status: 'Rusak' } });
  assert.equal(edit.statusCode, 200, edit.body);

  s = await summary();
  assert.equal(s.sudah, 1); assert.equal(s.percent, 50);
  assert.deepEqual(s.today, { found: 1, not_found: 1, multiple: 0, ref_changes: 1, status_changes: 1 });

  // Scan dan perubahan kemarin tidak dihitung sebagai hari ini.
  await f.db.query("UPDATE mapping_results SET scanned_at=now()-interval '2 days'");
  await f.db.query("UPDATE asset_history SET changed_at=now()-interval '2 days'");
  assert.deepEqual((await summary()).today, { found: 0, not_found: 0, multiple: 0, ref_changes: 0, status_changes: 0 });
});

test('laporan mapping dapat difilter menurut hasil (halaman SN tidak ditemukan)', async t => {
  const f = await fixture(); t.after(() => f.close());
  const admin = await f.login(); const tech = await f.login('teknisi');
  const scan = (scanned_sn: string) => f.app.inject({ method: 'POST', url: '/api/mapping-results', headers: tech, payload: { schedule_id: f.schedule, scanned_sn } });
  await scan('SN-001'); await scan('SN-BARU-1'); await scan('SN-BARU-2');
  const list = async (query: string) => {
    const res = await f.app.inject({ url: `/api/reports/mapping?${query}`, headers: admin });
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };
  const notFound = await list(`result=not_found&office_id=${f.office}&date_from=${f.day}&date_to=${f.day}`);
  assert.equal(notFound.meta.total, 2);
  assert.deepEqual(notFound.data.map((r: any) => r.scanned_sn).sort(), ['SN-BARU-1', 'SN-BARU-2']);
  assert.ok(notFound.data.every((r: any) => r.result === 'not_found' && r.eq === null && r.office_name === 'Grobogan' && r.technician_name === 'Teknisi'));
  assert.equal((await list('result=found')).meta.total, 1);
  assert.equal((await list('result=multiple')).meta.total, 0);
  assert.equal((await list(`result=not_found&office_id=${f.otherOffice}`)).meta.total, 0);
  assert.equal((await f.app.inject({ url: '/api/reports/mapping?result=salah', headers: admin })).statusCode, 422);
  assert.equal((await f.app.inject({ url: '/api/reports/mapping/export?result=not_found', headers: admin })).statusCode, 200);
});
