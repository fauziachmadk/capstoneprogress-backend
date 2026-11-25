import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';

test('admin menolak mapping: kembali belum, rejection tampil, hilang setelah teknisi mapping ulang', async t => {
  const f = await fixture(); t.after(() => f.close());
  const admin = await f.login(); const tech = await f.login('teknisi');
  const scan = () => f.app.inject({ method: 'POST', url: '/api/mapping-results', headers: tech, payload: { schedule_id: f.schedule, scanned_sn: 'SN-001', label_attached: true, label_code: 'LBL-1' } });
  const reject = (reason: unknown, headers = admin) => f.app.inject({ method: 'POST', url: `/api/assets/${f.asset}/reject`, headers, payload: { reason } });

  // Belum dimapping: tidak bisa ditolak.
  assert.equal((await reject('Foto buram')).statusCode, 409);
  assert.equal((await scan()).statusCode, 201);

  assert.equal((await reject('   ')).statusCode, 422);
  assert.equal((await reject('x'.repeat(501))).statusCode, 422);
  assert.equal((await reject('Foto buram', tech)).statusCode, 403);

  const rejected = await reject('  Foto buram  ');
  assert.equal(rejected.statusCode, 200, rejected.body);
  const asset = rejected.json().data;
  assert.equal(asset.mapping_status, 'belum');
  assert.equal(asset.label_code, 'LBL-1'); assert.equal(asset.label_status, 'terpasang');
  assert.equal(asset.rejection.reason, 'Foto buram'); assert.equal(asset.rejection.rejected_by, 'Admin');
  assert.ok(asset.rejection.rejected_at);

  // Sudah berstatus belum: tidak bisa ditolak dua kali.
  assert.equal((await reject('Lagi')).statusCode, 409);

  // Teknisi melihat penolakan lewat hasil pencocokan dan daftar aset.
  const match = await f.app.inject({ method: 'POST', url: '/api/scan/match', headers: tech, payload: { serial_number: 'SN-001', schedule_id: f.schedule } });
  assert.equal(match.json().data.assets[0].rejection.reason, 'Foto buram');
  const list = await f.app.inject({ url: `/api/technician/assets?schedule_id=${f.schedule}`, headers: tech });
  assert.equal(list.json().data.find((a: any) => a.id === f.asset).rejection.reason, 'Foto buram');

  // Mapping ulang menyelesaikan penolakan, riwayatnya tetap tersimpan.
  assert.equal((await scan()).statusCode, 201);
  const after = (await f.app.inject({ url: `/api/assets/${f.asset}`, headers: admin })).json().data;
  assert.equal(after.mapping_status, 'sudah'); assert.equal(after.rejection, null);
  const rows = (await f.db.query('SELECT reason, resolved_at FROM mapping_rejections WHERE asset_id=$1', [f.asset])).rows;
  assert.equal(rows.length, 1); assert.ok(rows[0].resolved_at);

  // Boleh ditolak lagi setelah mapping ulang; kini ada dua baris riwayat.
  assert.equal((await reject('Label miring')).statusCode, 200);
  assert.equal((await f.db.query('SELECT count(*) AS n FROM mapping_rejections WHERE asset_id=$1', [f.asset])).rows[0].n, 2);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/assets/999999/reject', headers: admin, payload: { reason: 'x' } })).statusCode, 404);
});
