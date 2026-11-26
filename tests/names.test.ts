import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';

test('respons jadwal dan scan memuat nama, bentuk sama dengan daftar', async t => {
  const f = await fixture(); t.after(() => f.close());
  const admin = await f.login(); const tech = await f.login('teknisi');
  const payload = { office_id: f.office, area: 'grobogan', scheduled_date: '2099-01-02', assigned_to: f.tech };
  const created = await f.app.inject({ method: 'POST', url: '/api/schedules', headers: admin, payload });
  assert.equal(created.statusCode, 201, created.body);
  const row = created.json().data;
  assert.equal(row.technician_name, 'Teknisi'); assert.equal(row.office_name, 'Grobogan'); assert.equal(row.scheduled_date, '2099-01-02');

  const listed = (await f.app.inject({ url: '/api/schedules?date=2099-01-02', headers: admin })).json().data.find((s: any) => s.id === row.id);
  assert.deepEqual(row, listed);

  const patched = await f.app.inject({ method: 'PATCH', url: `/api/schedules/${row.id}`, headers: admin, payload: { assigned_to: null } });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.json().data.technician_name, null); assert.equal(patched.json().data.scheduled_date, '2099-01-02');
  const cancelled = await f.app.inject({ method: 'DELETE', url: `/api/schedules/${row.id}`, headers: admin });
  assert.equal(cancelled.json().data.status, 'dibatalkan'); assert.equal(cancelled.json().data.office_code, 'KTR-GRB');

  const scan = await f.app.inject({ method: 'POST', url: '/api/mapping-results', headers: tech, payload: { schedule_id: f.schedule, scanned_sn: 'SN-001' } });
  assert.equal(scan.statusCode, 201, scan.body); assert.equal(scan.json().data.scanned_by_name, 'Teknisi');
});
