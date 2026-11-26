import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture } from './helpers.js';
import { loadConfig } from '../src/config.js';

const cloud = { CLOUDINARY_CLOUD_NAME: 'democloud', CLOUDINARY_API_KEY: '123456', CLOUDINARY_API_SECRET: 'demo-secret-value' };
const good = 'https://res.cloudinary.com/democloud/image/upload/v1/caps2tone/validasi/abc.jpg';

test('tanda tangan unggah: rumus Cloudinary, rahasia tidak bocor, hak akses', async t => {
  const f = await fixture(cloud); t.after(() => f.close());
  const tech = await f.login('teknisi'); const admin = await f.login(); const other = await f.login('lain');
  const sign = (headers: Record<string, string>, payload: object = { schedule_id: f.schedule }) => f.app.inject({ method: 'POST', url: '/api/uploads/sign', headers, payload });

  const res = await sign(tech);
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json().data;
  assert.equal(data.upload_url, 'https://api.cloudinary.com/v1_1/democloud/image/upload');
  assert.equal(data.cloud_name, 'democloud'); assert.equal(data.api_key, '123456');
  assert.deepEqual(Object.keys(data.params).sort(), ['allowed_formats', 'folder', 'timestamp']);
  assert.equal(data.params.folder, 'caps2tone/validasi'); assert.equal(data.params.allowed_formats, 'jpg,jpeg,png,webp');
  assert.ok(Math.abs(data.params.timestamp - Date.now() / 1000) < 60);
  const expected = createHash('sha1').update(`allowed_formats=jpg,jpeg,png,webp&folder=caps2tone/validasi&timestamp=${data.params.timestamp}demo-secret-value`).digest('hex');
  assert.equal(data.signature, expected);
  assert.equal(res.body.includes('demo-secret-value'), false);

  assert.equal((await sign(admin)).statusCode, 403);
  assert.ok([403, 404].includes((await sign(other)).statusCode));
  assert.equal((await sign(tech, {})).statusCode, 422);
  assert.equal((await sign(tech, { schedule_id: f.schedule, extra: 1 })).statusCode, 422);
});

test('tanda tangan dan photo_url ditolak 503 bila Cloudinary belum dikonfigurasi', async t => {
  const f = await fixture(); t.after(() => f.close());
  const tech = await f.login('teknisi');
  const sign = await f.app.inject({ method: 'POST', url: '/api/uploads/sign', headers: tech, payload: { schedule_id: f.schedule } });
  assert.equal(sign.statusCode, 503); assert.equal(sign.json().error.code, 'CLOUDINARY_NOT_CONFIGURED');
  const scan = await f.app.inject({ method: 'POST', url: '/api/mapping-results', headers: tech, payload: { schedule_id: f.schedule, scanned_sn: 'SN-001', photo_url: good } });
  assert.equal(scan.statusCode, 503);
  // Tanpa foto tetap berjalan seperti biasa.
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/mapping-results', headers: tech, payload: { schedule_id: f.schedule, scanned_sn: 'SN-001' } })).statusCode, 201);
});

test('foto tersimpan di scan dan aset, dipertahankan, dan hanya URL Cloudinary proyek ini yang diterima', async t => {
  const f = await fixture(cloud); t.after(() => f.close());
  const tech = await f.login('teknisi'); const admin = await f.login();
  const scan = (payload: object) => f.app.inject({ method: 'POST', url: '/api/mapping-results', headers: tech, payload: { schedule_id: f.schedule, scanned_sn: 'SN-001', ...payload } });
  const count = async () => (await f.db.query('SELECT count(*) AS n FROM mapping_results')).rows[0].n;

  for (const bad of ['http://res.cloudinary.com/democloud/image/upload/a.jpg', 'https://res.cloudinary.com.evil.com/democloud/image/upload/a.jpg',
    'https://evil.com/democloud/image/upload/a.jpg', 'https://res.cloudinary.com/othercloud/image/upload/a.jpg', 'https://u@res.cloudinary.com/democloud/image/upload/a.jpg',
    'https://res.cloudinary.com/democloud/image/upload/../../other/image/upload/a.jpg', 'https://res.cloudinary.com/democloud/video/upload/a.mp4', 'bukan url', '   ',
    `https://res.cloudinary.com/democloud/image/upload/${'a'.repeat(500)}`]) {
    assert.equal((await scan({ photo_url: bad })).statusCode, 422, bad.slice(0, 60));
  }
  assert.equal(await count(), 0);

  const first = await scan({ photo_url: good, label_attached: true, label_code: 'LBL-1' });
  assert.equal(first.statusCode, 201, first.body); assert.equal(first.json().data.photo_url, good);
  assert.equal((await f.app.inject({ url: `/api/assets/${f.asset}`, headers: admin })).json().data.photo_url, good);
  const listed = (await f.app.inject({ url: `/api/technician/assets?schedule_id=${f.schedule}`, headers: tech })).json().data.find((a: any) => a.id === f.asset);
  assert.equal(listed.photo_url, good);

  // Scan ulang tanpa foto tidak menghapus foto aset, dan scan itu sendiri tanpa foto.
  const second = await scan({});
  assert.equal(second.json().data.photo_url, null);
  assert.equal((await f.app.inject({ url: `/api/assets/${f.asset}`, headers: admin })).json().data.photo_url, good);
  const report = (await f.app.inject({ url: `/api/reports/mapping?schedule_id=${f.schedule}`, headers: admin })).json().data;
  assert.deepEqual(report.map((r: any) => r.photo_url).sort(), [good, null]);

  // Foto baru menggantikan foto aset; penolakan admin mempertahankan foto.
  const newer = 'https://res.cloudinary.com/democloud/image/upload/v2/caps2tone/validasi/def.png';
  assert.equal((await scan({ photo_url: newer })).statusCode, 201);
  const rejected = await f.app.inject({ method: 'POST', url: `/api/assets/${f.asset}/reject`, headers: admin, payload: { reason: 'Buram' } });
  assert.equal(rejected.json().data.photo_url, newer); assert.equal(rejected.json().data.mapping_status, 'belum');

  // SN asing dengan foto: bukti hanya di scan, tidak menyentuh aset mana pun.
  const unknown = await scan({ scanned_sn: 'TIDAK-ADA', photo_url: good });
  assert.equal(unknown.json().data.result, 'not_found'); assert.equal(unknown.json().data.photo_url, good);
});

test('konfigurasi Cloudinary harus lengkap atau kosong', () => {
  const base = { DATABASE_URL: 'postgresql://x', AUTH_SECRET: 'x'.repeat(32) };
  assert.doesNotThrow(() => loadConfig(base));
  assert.doesNotThrow(() => loadConfig({ ...base, ...cloud }));
  assert.throws(() => loadConfig({ ...base, CLOUDINARY_CLOUD_NAME: 'democloud' }), /CLOUDINARY/);
  assert.throws(() => loadConfig({ ...base, ...cloud, CLOUDINARY_CLOUD_NAME: 'bad name/' }), /CLOUDINARY_CLOUD_NAME/);
});
