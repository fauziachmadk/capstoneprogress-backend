import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';

test('GET /api/assets mengurutkan di server dengan sort dan dir, dan menolak kolom di luar daftar', async t => {
  const f = await fixture(); t.after(() => f.close());
  const admin = await f.login(); const tech = await f.login('teknisi');
  // Ada EQ-001 (chassis, Grobogan) dan EQ-OTHER (chassis, Solo); tambah modul agar urutan jenis dan kantor bervariasi.
  await f.db.query("INSERT INTO assets(eq,kind,serial_number,office_id,parent_id,ref) VALUES('EQ-AAA','module','SN-ZZZ',$1,$2,'Z-REF'),('EQ-MMM','module','SN-AAA',$3,NULL,'A-REF')", [f.office, f.asset, f.otherOffice]);
  const list = async (query: string) => { const res = await f.app.inject({ url: `/api/assets?${query}`, headers: admin }); assert.equal(res.statusCode, 200, `${query} ${res.body}`); return res.json(); };
  const eqs = async (query: string) => (await list(query)).data.map((a: any) => a.eq);

  assert.deepEqual(await eqs(''), ['EQ-001', 'EQ-AAA', 'EQ-MMM', 'EQ-OTHER']);
  assert.deepEqual(await eqs('sort=eq&dir=desc'), ['EQ-OTHER', 'EQ-MMM', 'EQ-AAA', 'EQ-001']);
  // SN: SN-001, SN-AAA, SN-OTHER, SN-ZZZ
  assert.deepEqual(await eqs('sort=serial_number'), ['EQ-001', 'EQ-MMM', 'EQ-OTHER', 'EQ-AAA']);
  // REF: Z-REF, OLD, A-REF, kosong
  assert.deepEqual(await eqs('sort=ref&dir=desc'), ['EQ-AAA', 'EQ-001', 'EQ-MMM', 'EQ-OTHER']);
  // Kantor Grobogan (001, AAA) lalu Solo (OTHER, MMM); sama-sama menurut id.
  assert.deepEqual(await eqs('sort=office'), ['EQ-001', 'EQ-AAA', 'EQ-OTHER', 'EQ-MMM']);
  assert.deepEqual(await eqs('sort=office&dir=desc'), ['EQ-OTHER', 'EQ-MMM', 'EQ-001', 'EQ-AAA']);
  assert.deepEqual(await eqs('sort=kind&dir=desc&search=EQ-'), ['EQ-AAA', 'EQ-MMM', 'EQ-001', 'EQ-OTHER']);

  // Urutan tetap stabil lintas halaman dan total ikut filter.
  const page1 = await list('sort=eq&dir=desc&limit=2&page=1'); const page2 = await list('sort=eq&dir=desc&limit=2&page=2');
  assert.deepEqual([...page1.data, ...page2.data].map((a: any) => a.eq), ['EQ-OTHER', 'EQ-MMM', 'EQ-AAA', 'EQ-001']); assert.equal(page2.meta.total, 4);

  // Bentuk baris yang dipakai tabel admin.
  const row = (await list('search=EQ-001')).data[0];
  for (const key of ['id', 'eq', 'kind', 'serial_number', 'office_name', 'office_code', 'mapping_status', 'label_status', 'label_code', 'photo_url', 'rejection']) assert.ok(key in row, key);

  for (const bad of ['sort=password', 'sort=a.eq;drop', 'dir=sideways', 'sort=']) assert.equal((await f.app.inject({ url: `/api/assets?${bad}`, headers: admin })).statusCode, 422, bad);
  assert.equal((await f.app.inject({ url: '/api/assets?sort=eq', headers: tech })).statusCode, 403);
});
