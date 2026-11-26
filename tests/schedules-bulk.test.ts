import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';

async function offices(f: Awaited<ReturnType<typeof fixture>>) {
  const rows = (await f.db.query("INSERT INTO offices(code,name,area) VALUES('KTR-A','Alfa','grobogan'),('KTR-B','Bravo','grobogan'),('KTR-C','Charlie','grobogan') RETURNING id,name")).rows;
  return { a: rows[0].id as number, b: rows[1].id as number, c: rows[2].id as number };
}
const day = '2099-03-01';

test('buat jadwal banyak kantor sekaligus: array terurut, duplikat digabung, objek tunggal tetap', async t => {
  const f = await fixture(); t.after(() => f.close());
  const admin = await f.login(); const o = await offices(f);
  const post = (payload: object) => f.app.inject({ method: 'POST', url: '/api/schedules', headers: admin, payload });

  const many = await post({ office_ids: [o.c, o.a, o.b, o.a], area: 'grobogan', scheduled_date: day, assigned_to: f.tech });
  assert.equal(many.statusCode, 201, many.body);
  const data = many.json().data;
  assert.deepEqual(data.map((r: any) => r.office_name), ['Alfa', 'Bravo', 'Charlie']);
  assert.ok(data.every((r: any) => r.technician_name === 'Teknisi' && r.scheduled_date === day && r.status === 'terjadwal' && r.created_by === f.admin));

  const single = await post({ office_id: o.a, area: 'grobogan', scheduled_date: '2099-03-02' });
  assert.equal(single.statusCode, 201, single.body);
  assert.equal(Array.isArray(single.json().data), false); assert.equal(single.json().data.office_name, 'Alfa');
  assert.equal(single.json().data.technician_name, null);
});

test('buat jadwal banyak kantor: bentrok menyebut nama kantor dan tidak menyimpan apa pun', async t => {
  const f = await fixture(); t.after(() => f.close());
  const admin = await f.login(); const o = await offices(f);
  const post = (payload: object) => f.app.inject({ method: 'POST', url: '/api/schedules', headers: admin, payload });
  assert.equal((await post({ office_id: o.a, area: 'grobogan', scheduled_date: day })).statusCode, 201);

  const clash = await post({ office_ids: [o.a, o.b, o.c], area: 'grobogan', scheduled_date: day });
  assert.equal(clash.statusCode, 409, clash.body);
  const error = clash.json().error;
  assert.equal(error.code, 'SCHEDULE_CONFLICT'); assert.match(error.message, /Alfa/);
  assert.deepEqual(error.details.offices.map((x: any) => x.office_name), ['Alfa']);
  assert.equal((await f.db.query('SELECT count(*) AS n FROM mapping_schedules WHERE office_id=ANY($1::integer[])', [[o.b, o.c]])).rows[0].n, 0);

  // Jadwal yang dibatalkan tidak lagi bentrok.
  const first = (await f.app.inject({ url: `/api/schedules?office_id=${o.a}&date=${day}`, headers: admin })).json().data[0];
  assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/schedules/${first.id}`, headers: admin })).statusCode, 200);
  assert.equal((await post({ office_ids: [o.a, o.b], area: 'grobogan', scheduled_date: day })).statusCode, 201);
});

test('buat jadwal banyak kantor: validasi bersifat atomik', async t => {
  const f = await fixture(); t.after(() => f.close());
  const admin = await f.login(); const o = await offices(f);
  const post = (payload: object) => f.app.inject({ method: 'POST', url: '/api/schedules', headers: admin, payload });
  const base = { area: 'grobogan', scheduled_date: day };
  const count = async () => (await f.db.query('SELECT count(*) AS n FROM mapping_schedules')).rows[0].n;
  const before = await count();

  assert.equal((await post({ ...base })).statusCode, 422);
  assert.equal((await post({ ...base, office_id: o.a, office_ids: [o.b] })).statusCode, 422);
  assert.equal((await post({ ...base, office_ids: [] })).statusCode, 422);
  assert.equal((await post({ ...base, office_ids: Array.from({ length: 51 }, (_, i) => i + 1) })).statusCode, 422);
  assert.equal((await post({ ...base, office_ids: [o.a, f.otherOffice] })).json().error.code, 'AREA_MISMATCH');
  assert.equal((await post({ ...base, office_ids: [o.a, 999999] })).statusCode, 404);
  assert.equal((await post({ ...base, office_ids: [o.a], scheduled_date: '2000-01-01' })).json().error.code, 'PAST_DATE');
  assert.equal((await post({ ...base, office_ids: [o.a], assigned_to: f.other })).json().error.code, 'TECHNICIAN_AREA_MISMATCH');
  assert.equal(await count(), before);
});

test('filter daftar jadwal: rentang tanggal, pencarian, belum ditugaskan, dan hak teknisi', async t => {
  const f = await fixture(); t.after(() => f.close());
  const admin = await f.login(); const tech = await f.login('teknisi'); const o = await offices(f);
  const post = (payload: object) => f.app.inject({ method: 'POST', url: '/api/schedules', headers: admin, payload });
  await post({ office_id: o.a, area: 'grobogan', scheduled_date: '2099-04-01', assigned_to: f.tech });
  await post({ office_id: o.b, area: 'grobogan', scheduled_date: '2099-04-05' });
  await post({ office_id: o.c, area: 'grobogan', scheduled_date: '2099-04-09', assigned_to: f.tech });
  const names = async (query: string, headers = admin) => {
    const res = await f.app.inject({ url: `/api/schedules?${query}`, headers });
    assert.equal(res.statusCode, 200, res.body);
    return { names: res.json().data.map((r: any) => r.office_name), total: res.json().meta.total };
  };

  assert.deepEqual(await names('date_from=2099-04-02&date_to=2099-04-09'), { names: ['Bravo', 'Charlie'], total: 2 });
  assert.deepEqual(await names('date_from=2099-04-06'), { names: ['Charlie'], total: 1 });
  assert.deepEqual(await names('date_to=2099-04-01&date_from=2099-01-01'), { names: ['Alfa'], total: 1 });
  assert.deepEqual(await names('date_from=2099-01-01&search=bRav'), { names: ['Bravo'], total: 1 });
  assert.deepEqual(await names('date_from=2099-01-01&search=teknis&limit=1&page=2'), { names: ['Charlie'], total: 2 });
  assert.deepEqual(await names('date_from=2099-01-01&unassigned=true'), { names: ['Bravo'], total: 1 });
  assert.deepEqual(await names('date_from=2099-01-01&search=%25'), { names: [], total: 0 });

  assert.equal((await f.app.inject({ url: '/api/schedules?date_from=2099-05-01&date_to=2099-04-01', headers: admin })).statusCode, 422);
  assert.equal((await f.app.inject({ url: '/api/schedules?unassigned=true', headers: tech })).statusCode, 403);
  // Teknisi tanpa filter tanggal tetap hanya melihat hari ini; dengan rentang, melihat jadwal miliknya
  // dan jadwal belum ditugaskan di areanya (Bravo) dalam rentang itu.
  assert.deepEqual((await names('', tech)).names, ['Grobogan']);
  assert.deepEqual((await names('date_from=2099-01-01&date_to=2099-12-31', tech)).names, ['Alfa', 'Bravo', 'Charlie']);
  assert.deepEqual((await names('date_from=2099-01-01&date_to=2099-12-31&search=bravo', tech)).names, ['Bravo']);
});
