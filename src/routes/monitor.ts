import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';

export const monitorPublicPaths = new Set(['/', '/ping', '/monitor', '/monitor/', '/monitor/index.html', '/monitor/style.css', '/monitor/app.js']);

export function registerMonitor(app: FastifyInstance) {
  app.get('/', { schema: { hide: true } }, async (_request, reply) => reply.redirect('/monitor/'));
  app.get('/monitor', { schema: { hide: true } }, async (_request, reply) => reply.redirect('/monitor/'));
  for (const [path, filename, type] of [
    ['/monitor/', 'index.html', 'text/html'],
    ['/monitor/index.html', 'index.html', 'text/html'],
    ['/monitor/style.css', 'style.css', 'text/css'],
    ['/monitor/app.js', 'app.js', 'text/javascript'],
  ]) {
    app.get(path, { schema: { hide: true } }, async (_request, reply) => {
      const content = await readFile(new URL(`../../public/monitor/${filename}`, import.meta.url));
      return reply.header('Cache-Control', 'no-store').type(`${type}; charset=utf-8`).send(content);
    });
  }
  app.get('/ping', { schema: { security: [], tags: ['health'], summary: 'Ping server tanpa mengakses database' } }, async () => ({
    data: { status: 'ok', service: 'Caps2Tone API', timestamp: new Date().toISOString() },
  }));
}
