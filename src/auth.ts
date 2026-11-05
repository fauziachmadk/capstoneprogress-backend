import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Database } from './db.js';
import { ApiError } from './errors.js';
import bcrypt from 'bcryptjs';
import { monitorPublicPaths } from './routes/monitor.js';
const scrypt = promisify(scryptCallback);
export type User = { id: number; name: string; username: string; role: 'admin' | 'teknisi'; areas: string[]; is_active: boolean; telegram_chat_id?: string | null };
declare module 'fastify' { interface FastifyRequest { user: User | null } }
export const sessionCookie = 'caps2tone_session';
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const csrfToken = (token: string, secret: string) => createHmac('sha256', secret).update(token).digest('hex');
export function secureEqual(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export async function hashPassword(password: string): Promise<string> {
  if (Buffer.byteLength(password, 'utf8') > 72) throw new ApiError(422, 'PASSWORD_TOO_LONG', 'Password bcrypt maksimal 72 byte UTF-8.');
  return bcrypt.hash(password, 12);
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (encoded.startsWith('$2')) return Buffer.byteLength(password, 'utf8') <= 72 && bcrypt.compare(password, encoded);
  const [algorithm, salt, stored] = encoded.split(':');
  if (algorithm !== 'scrypt' || !salt || !stored) return false;
  const derived = await scrypt(password, salt, 64) as Buffer;
  return secureEqual(derived.toString('hex'), stored);
}
export function requireRole(request: FastifyRequest, ...roles: User['role'][]): User {
  if (!request.user) throw new ApiError(401, 'UNAUTHENTICATED', 'Silakan login.');
  if (roles.length && !roles.includes(request.user.role)) throw new ApiError(403, 'FORBIDDEN', 'Akses ditolak.');
  return request.user;
}
export function registerAuth(app: FastifyInstance, db: Database, config: Config) {
  const cookieOptions = { path: '/', httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: config.COOKIE_SAME_SITE } as const;
  app.decorateRequest('user', null);
  app.addHook('onRequest', async request => {
    const path = request.url.split('?')[0];
    if (request.method === 'OPTIONS') return;
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (unsafe && request.headers.origin && !config.FRONTEND_ORIGINS.split(',').map(v => v.trim()).includes(request.headers.origin)) {
      throw new ApiError(403, 'ORIGIN_DENIED', 'Origin tidak diizinkan.');
    }
    if (path === '/api/auth/login' || path === '/health' || monitorPublicPaths.has(path) || path.startsWith('/docs') || path.startsWith('/api/cron/')) return;
    const token = request.cookies[sessionCookie];
    if (!token || token.length !== 64) throw new ApiError(401, 'UNAUTHENTICATED', 'Silakan login.');
    const { rows } = await db.query<User>(`SELECT u.id,u.name,u.username,u.role,u.areas::text[] AS areas,u.is_active,u.telegram_chat_id FROM sessions s
      JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.is_active`, [hashToken(token)]);
    request.user = rows[0] ?? null;
    requireRole(request);
    if (unsafe && !secureEqual(String(request.headers['x-csrf-token'] ?? ''), csrfToken(token, config.AUTH_SECRET))) {
      throw new ApiError(403, 'CSRF_INVALID', 'Token CSRF tidak valid.');
    }
  });
  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const input = z.object({ username: z.string().trim().min(1).max(100).transform(v => v.toLowerCase()), password: z.string().min(1).max(1024) }).strict().parse(request.body);
    const { rows } = await db.query<User & { password_hash: string }>('SELECT id,name,username,role,areas::text[] AS areas,is_active,password_hash FROM users WHERE lower(username)=lower($1) AND is_active', [input.username]);
    const user = rows[0];
    // Run the same expensive operation for unknown users to reduce username timing leaks.
    const dummy = '$2b$12$C6UzMDM.H6dfI/f/IKcEe.zeRV4BVO8U1CqVMKe0/7VPuqOhYZO3e';
    const valid = await verifyPassword(input.password, user?.password_hash ?? dummy);
    if (!user || !valid) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Username atau password salah.');
    const token = randomBytes(32).toString('hex');
    await db.transaction(async tx => {
      await tx.query('DELETE FROM sessions WHERE expires_at <= now()');
      await tx.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '8 hours')", [hashToken(token), user.id]);
    });
    reply.setCookie(sessionCookie, token, { ...cookieOptions, maxAge: 8 * 3600 });
    return { data: { user: { id: user.id, name: user.name, username: user.username, role: user.role, areas: user.areas, is_active: user.is_active }, csrf_token: csrfToken(token, config.AUTH_SECRET) } };
  });
  app.get('/api/auth/me', async request => {
    const user = requireRole(request);
    const { rows } = await db.query('SELECT area FROM technician_areas WHERE user_id=$1 ORDER BY area', [user.id]);
    return { data: { user, areas: rows.map(r => r.area), csrf_token: csrfToken(request.cookies[sessionCookie]!, config.AUTH_SECRET) } };
  });
  app.post('/api/auth/logout', async (request, reply) => {
    requireRole(request);
    await db.query('DELETE FROM sessions WHERE token_hash=$1', [hashToken(request.cookies[sessionCookie]!)]);
    reply.clearCookie(sessionCookie, cookieOptions);
    return { data: { message: 'Berhasil logout.' } };
  });
}
