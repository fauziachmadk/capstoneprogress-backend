import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';

const password = 'password-for-new-user';
const body = { name: 'Calon Teknisi', username: ' Calon.Teknisi ', password, employee_type: 'magang', areas: ['solo'] };

test('pendaftaran mandiri: menunggu, login ditolak, disetujui admin, lalu bisa login', async t => {
  const f = await fixture(); t.after(() => f.close());
  const register = await f.app.inject({ method: 'POST', url: '/api/auth/register', payload: body });
  assert.equal(register.statusCode, 201, register.body);
  const created = register.json().data;
  assert.equal(created.username, 'calon.teknisi'); assert.equal(created.approval_status, 'menunggu');
  assert.equal(created.employee_type, 'magang'); assert.deepEqual(created.areas, ['solo']); assert.equal(created.password_hash, undefined);
  const row = (await f.db.query('SELECT role,is_active,password_hash FROM users WHERE id=$1', [created.id])).rows[0];
  assert.equal(row.role, 'teknisi'); assert.equal(row.is_active, false); assert.match(row.password_hash, /^\$2/);

  // Password salah tidak membocorkan status; password benar memberi pesan menunggu.
  const wrong = await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'calon.teknisi', password: 'salah-salah-salah' } });
  assert.equal(wrong.statusCode, 401);
  const pending = await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'calon.teknisi', password } });
  assert.equal(pending.statusCode, 403); assert.equal(pending.json().error.code, 'ACCOUNT_PENDING');

  const admin = await f.login();
  const list = await f.app.inject({ url: '/api/users?approval_status=menunggu', headers: admin });
  assert.equal(list.statusCode, 200, list.body); assert.equal(list.json().meta.total, 1);
  assert.equal(list.json().data[0].id, created.id);

  const approved = await f.app.inject({ method: 'PATCH', url: `/api/users/${created.id}`, headers: admin, payload: { approval_status: 'aktif' } });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal(approved.json().data.is_active, true); assert.equal(approved.json().data.decided_by, f.admin);
  assert.ok(approved.json().data.decided_at);
  const ok = await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'calon.teknisi', password } });
  assert.equal(ok.statusCode, 200, ok.body);

  // Dinonaktifkan: sesi dicabut dan login kembali generik.
  const cookie = `caps2tone_session=${ok.cookies.find(c => c.name === 'caps2tone_session')!.value}`;
  const off = await f.app.inject({ method: 'PATCH', url: `/api/users/${created.id}`, headers: admin, payload: { approval_status: 'nonaktif' } });
  assert.equal(off.statusCode, 200, off.body); assert.equal(off.json().data.is_active, false);
  assert.equal((await f.app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode, 401);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'calon.teknisi', password } })).statusCode, 401);
});

test('pendaftaran ditolak admin dan validasi input', async t => {
  const f = await fixture(); t.after(() => f.close());
  const created = (await f.app.inject({ method: 'POST', url: '/api/auth/register', payload: body })).json().data;
  const admin = await f.login();
  assert.equal((await f.app.inject({ method: 'PATCH', url: `/api/users/${created.id}`, headers: admin, payload: { approval_status: 'ditolak' } })).statusCode, 200);
  const rejected = await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'calon.teknisi', password } });
  assert.equal(rejected.statusCode, 403); assert.equal(rejected.json().error.code, 'ACCOUNT_REJECTED');

  assert.equal((await f.app.inject({ method: 'POST', url: '/api/auth/register', payload: body })).statusCode, 409);
  for (const bad of [{ ...body, username: 'ab' }, { ...body, username: 'baru.1', password: 'pendek' }, { ...body, username: 'baru.2', areas: [] }]) {
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/auth/register', payload: bad })).statusCode, 422, JSON.stringify(bad));
  }
  // Permintaan ke-6 dalam semenit dibatasi.
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/auth/register', payload: { ...body, username: 'baru.9' } })).statusCode, 429);
  assert.equal((await f.db.query("SELECT count(*) AS n FROM users WHERE role='admin'")).rows[0].n, 1);
});

test('admin terakhir tidak bisa dinonaktifkan lewat approval_status; is_active dan approval_status sinkron', async t => {
  const f = await fixture(); t.after(() => f.close());
  const admin = await f.login();
  assert.equal((await f.app.inject({ method: 'PATCH', url: `/api/users/${f.admin}`, headers: admin, payload: { approval_status: 'nonaktif' } })).statusCode, 409);
  const made = await f.app.inject({ method: 'POST', url: '/api/users', headers: admin, payload: { name: 'X', username: 'x.user', password, role: 'teknisi', areas: ['solo'], is_active: false } });
  assert.equal(made.statusCode, 201, made.body); assert.equal(made.json().data.approval_status, 'nonaktif');
  const on = await f.app.inject({ method: 'PATCH', url: `/api/users/${made.json().data.id}`, headers: admin, payload: { is_active: true } });
  assert.equal(on.json().data.approval_status, 'aktif');
  const lama = (await f.db.query("SELECT approval_status, employee_type FROM users WHERE username='teknisi'")).rows[0];
  assert.deepEqual({ ...lama }, { approval_status: 'aktif', employee_type: 'karyawan' });
});

test('validasi pendaftaran: area ganda, role/field asing, tipe tidak dikenal', async t => {
  const f = await fixture(); t.after(() => f.close());
  for (const bad of [{ ...body, username: 'baru.3', areas: ['solo', 'solo'] }, { ...body, username: 'baru.4', role: 'admin' },
    { ...body, username: 'baru.5', employee_type: 'dewa' }, { ...body, username: 'baru.6', approval_status: 'aktif' }]) {
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/auth/register', payload: bad })).statusCode, 422, JSON.stringify(bad));
  }
  assert.equal((await f.db.query('SELECT count(*) AS n FROM users')).rows[0].n, 3);
});
