import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db.js';
const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
const app = await buildApp({ db, config });
try {
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const health = await fetch(`${base}/health`); assert.equal(health.status, 200);
  const denied = await fetch(`${base}/api/assets`); assert.equal(denied.status, 401);
  const username = process.env.SEED_ADMIN_USERNAME || 'admin';
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password) throw new Error('Isi SEED_ADMIN_PASSWORD untuk smoke test akun seed.');
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.equal(login.status, 200, 'Login akun seed gagal.');
  const body = await login.json() as { data: { csrf_token: string } };
  const cookie = login.headers.getSetCookie().find(c => c.startsWith('caps2tone_session='))!.split(';')[0];
  const headers = { cookie, 'x-csrf-token': body.data.csrf_token };
  try {
    for (const path of ['/api/auth/me', '/api/users', '/api/offices', '/api/assets', '/api/schedules', '/api/dashboard/progress', '/api/reports/mapping']) {
      const result = await fetch(base + path, { headers }); assert.equal(result.status, 200, `HTTP ${path} gagal.`);
    }
  } finally {
    const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers }); assert.equal(logout.status, 200);
  }
  assert.equal((await fetch(`${base}/api/auth/me`, { headers })).status, 401);
  console.log('Smoke HTTP + PostgreSQL berhasil: health, login, 7 endpoint, logout/revocation.');
} finally { await app.close(); await db.close(); }
