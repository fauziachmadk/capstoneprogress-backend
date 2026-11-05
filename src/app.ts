import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import type { Database } from './db.js';
import { registerAuth } from './auth.js';
import { ApiError } from './errors.js';
import { registerAssets } from './routes/assets.js';
import { registerSchedules } from './routes/schedules.js';
import { registerReports } from './routes/reports.js';
import { registerNotifications, type TelegramSender } from './routes/notifications.js';
import { contractSchema } from './contracts.js';
import { registerUsers } from './routes/users.js';
import { registerMonitor } from './routes/monitor.js';

export async function buildApp(options: { db: Database; config: Config; logger?: boolean; sendTelegram?: TelegramSender; closeDatabaseOnClose?: boolean }) {
  const { db, config } = options;
  const app = Fastify({
    logger: options.logger ? { redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers.x-csrf-token'] } : false,
    bodyLimit: 1024 * 1024, trustProxy: process.env.VERCEL === '1',
  });
  if (options.closeDatabaseOnClose) app.addHook('onClose', async () => { await db.close(); });
  await app.register(helmet);
  await app.register(cors, { origin: config.FRONTEND_ORIGINS.split(',').map(v => v.trim()), credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'X-CSRF-Token'] });
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: 3 * 1024 * 1024, files: 1, fields: 0, parts: 1 } });
  await app.register(swagger, { openapi: { info: { title: 'Caps2Tone Backend API', version: '1.0.0' },
    components: {
      securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'caps2tone_session' }, cron: { type: 'http', scheme: 'bearer' } },
      schemas: { ApiError: { type: 'object', properties: { error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } } } } },
    },
    security: [{ session: [] }],
  }, transform: ({ schema, url, route }) => ({ schema: { ...schema, ...contractSchema(String(route.method), url) }, url }) });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Input tidak valid.', details: error.issues.map(i => ({ field: i.path.join('.'), message: i.message })) } });
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    const e = error as { code?: string; statusCode?: number };
    const dbErrors: Record<string, [number, string, string]> = {
      '23505': [409, 'CONFLICT', 'Data duplikat atau jadwal aktif sudah ada.'],
      '23503': [409, 'REFERENCE_CONFLICT', 'Data masih dipakai atau referensi tidak tersedia.'],
      '23001': [409, 'REFERENCE_CONFLICT', 'Data masih dipakai dan tidak dapat dihapus.'],
      '23514': [422, 'CONSTRAINT_ERROR', 'Relasi atau nilai data tidak valid.'],
      '22P02': [422, 'INVALID_VALUE', 'Nilai data tidak valid.'],
      '40001': [409, 'RETRY_TRANSACTION', 'Data berubah bersamaan. Silakan ulangi.'],
      '40P01': [409, 'RETRY_TRANSACTION', 'Data berubah bersamaan. Silakan ulangi.'],
    };
    if (e.code && dbErrors[e.code]) {
      const [code, name, message] = dbErrors[e.code];
      return reply.code(code).send({ error: { code: name, message } });
    }
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: { code: e.code ?? 'BAD_REQUEST', message: e.statusCode === 429 ? 'Terlalu banyak permintaan.' : 'Permintaan tidak valid.' } });
    request.log.error({ err: error }, 'Request failed');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Terjadi kesalahan server.' } });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Endpoint tidak ditemukan.' } }));
  registerAuth(app, db, config);
  registerMonitor(app);
  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });
  app.get('/health', { schema: { security: [] } }, async () => {
    await db.query('SELECT 1');
    return { data: { status: 'ok' } };
  });
  registerAssets(app, db, config);
  registerUsers(app, db);
  registerSchedules(app, db, config);
  registerReports(app, db, config);
  registerNotifications(app, db, config, options.sendTelegram);
  await app.ready();
  return app;
}
