import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
test('entrypoint server dapat listen dan melayani HTTP tanpa kredensial cloud', { timeout: 15000 }, async () => {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port),
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused', AUTH_SECRET: 'server-test-secret-with-at-least-32-characters',
      COOKIE_SAME_SITE: 'lax', FRONTEND_ORIGINS: 'http://localhost:3000' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = ''; let timeout: ReturnType<typeof setTimeout> | undefined;
  const exited = once(child, 'exit');
  try {
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Server tidak siap dalam 10 detik.')), 10000);
      child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('Server listening at')) resolve(); });
      child.stderr.on('data', chunk => { output += String(chunk); });
      child.once('exit', () => reject(new Error(`Server berhenti sebelum siap: ${output}`)));
      child.once('error', reject);
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/assets`);
    assert.equal(response.status, 401); assert.equal((await response.json() as any).error.code, 'UNAUTHENTICATED');
  } finally {
    clearTimeout(timeout); child.kill(); await exited;
  }
});
