import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/db.js';

test('monitor dan ping publik tetap dapat dibuka saat database tidak tersedia; API data tetap terlindungi', async t => {
  let queries=0;
  const db:Database={query:async()=>{queries++;throw new Error('database unavailable');},transaction:async()=>{throw new Error('unavailable');},close:async()=>{}};
  const config=loadConfig({NODE_ENV:'test',DATABASE_URL:'postgresql://test:test@localhost/test',AUTH_SECRET:'monitor-test-secret-at-least-32-characters'});
  const app=await buildApp({db,config});t.after(()=>app.close());
  const root=await app.inject('/');assert.equal(root.statusCode,302);assert.equal(root.headers.location,'/monitor/');
  const page=await app.inject('/monitor/');assert.equal(page.statusCode,200);assert.match(String(page.headers['content-type']),/text\/html/);
  assert.equal(page.headers['cache-control'],'no-store');assert.ok(page.headers['content-security-policy']);
  assert.match(page.body,/id="ping-button"/);assert.match(page.body,/\.\/app.js/);
  for(const path of ['/monitor/style.css','/monitor/app.js'])assert.equal((await app.inject(path)).statusCode,200);
  const ping=await app.inject('/ping');assert.equal(ping.statusCode,200);assert.equal(ping.json().data.status,'ok');assert.equal(queries,0);
  assert.equal((await app.inject('/api/assets')).statusCode,401);
  assert.equal((await app.inject('/health')).statusCode,500);assert.equal(queries,1);
});
