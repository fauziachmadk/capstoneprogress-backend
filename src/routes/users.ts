import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db.js';
import { hashPassword, requireRole } from '../auth.js';
import { ApiError, assertExists } from '../errors.js';
import { area, paramId, text } from '../validation.js';
const publicColumns = 'id,name,username,role,employee_type,approval_status,areas::text[] AS areas,telegram_chat_id,is_active,decided_at,decided_by,created_at,updated_at';
const employeeType = z.enum(['karyawan', 'magang']);
const approvalStatus = z.enum(['menunggu', 'aktif', 'ditolak', 'nonaktif']);
const fields = z.object({
  name: text, username: text.max(100).transform(v => v.toLowerCase()), password: z.string().min(12).max(72),
  role: z.enum(['admin', 'teknisi']), areas: z.array(area).max(2).refine(v => new Set(v).size === v.length, 'Area tidak boleh duplikat.'),
  telegram_chat_id: z.string().trim().max(100).nullable(), is_active: z.boolean(),
  employee_type: employeeType, approval_status: approvalStatus,
}).strict();
function validateAreas(role: string, areas: string[]) {
  if (role === 'teknisi' && !areas.length) throw new ApiError(422, 'AREA_REQUIRED', 'Teknisi memerlukan minimal satu area.');
  if (role === 'admin' && areas.length) throw new ApiError(422, 'ADMIN_AREAS_INVALID', 'Area layanan hanya untuk teknisi.');
}
export function registerUsers(app: FastifyInstance, db: Database) {
  app.post('/api/users', async (request, reply) => {
    requireRole(request, 'admin');
    const input = fields.extend({ areas: fields.shape.areas.default([]), telegram_chat_id: fields.shape.telegram_chat_id.default(null), is_active: z.boolean().default(true), employee_type: employeeType.default('karyawan'), approval_status: approvalStatus.default('aktif') }).parse(request.body);
    validateAreas(input.role, input.areas);
    const hash = await hashPassword(input.password);
    const row = (await db.query(`INSERT INTO users(name,username,password_hash,role,areas,telegram_chat_id,is_active,employee_type,approval_status)
      VALUES($1,$2,$3,$4,$5::text[]::area_type[],$6,$7,$8,$9) RETURNING ${publicColumns}`,
    [input.name, input.username, hash, input.role, input.areas, input.telegram_chat_id, input.is_active, input.employee_type, input.approval_status])).rows[0];
    return reply.code(201).send({ data: row });
  });
  app.patch('/api/users/:id', async request => {
    const actor = requireRole(request, 'admin'); const userId = paramId(request);
    const input = fields.partial().refine(v => Object.keys(v).length > 0, 'Tidak ada perubahan.').parse(request.body);
    const hash = input.password === undefined ? undefined : await hashPassword(input.password);
    const row = await db.transaction(async tx => {
      // Lock administrators first, in one order, when privileges may change.
      const admins = (await tx.query("SELECT id FROM users WHERE role='admin' AND is_active ORDER BY id FOR UPDATE")).rows;
      const old = assertExists((await tx.query(`SELECT ${publicColumns} FROM users WHERE id=$1 FOR UPDATE`, [userId])).rows[0]);
      const role = input.role ?? old.role; const areas = input.areas ?? old.areas;
      const deactivates = input.approval_status !== undefined && input.approval_status !== 'aktif';
      validateAreas(role, areas);
      if (old.role === 'admin' && old.is_active && (role !== 'admin' || input.is_active === false || deactivates) && admins.length <= 1) {
        throw new ApiError(409, 'LAST_ADMIN', 'Minimal satu admin aktif harus dipertahankan.');
      }
      if ((input.role !== undefined || input.areas !== undefined) && (await tx.query(`SELECT 1 FROM mapping_schedules
        WHERE assigned_to=$1 AND status IN ('terjadwal','berjalan') AND ($2::text<>'teknisi' OR NOT area=ANY($3::text[]::area_type[])) LIMIT 1`, [userId, role, areas])).rows.length) {
        throw new ApiError(409, 'USER_HAS_SCHEDULES', 'Alihkan jadwal aktif sebelum mengganti role atau area teknisi.');
      }
      const values: any[] = []; const sets: string[] = [];
      for (const key of ['name', 'username', 'role', 'areas', 'telegram_chat_id', 'is_active', 'employee_type', 'approval_status'] as const) {
        if (input[key] !== undefined) { values.push(input[key]); sets.push(`${key}=$${values.length}${key === 'areas' ? '::text[]::area_type[]' : ''}`); }
      }
      if (hash) { values.push(hash); sets.push(`password_hash=$${values.length}`); }
      if (input.approval_status !== undefined) { values.push(actor.id); sets.push(`decided_by=$${values.length}`, 'decided_at=now()'); }
      values.push(userId);
      const updated = (await tx.query(`UPDATE users SET ${sets.join(',')} WHERE id=$${values.length} RETURNING ${publicColumns}`, values)).rows[0];
      if (hash || input.is_active === false || deactivates || input.role !== undefined || input.areas !== undefined) await tx.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
      return updated;
    });
    return { data: row };
  });
  // Pendaftaran mandiri dari halaman /daftar. Selalu teknisi dengan status 'menunggu'; admin yang menyetujui.
  app.post('/api/auth/register', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const input = z.object({
      name: text,
      username: text.max(100).transform(v => v.toLowerCase()).refine(v => /^[a-z0-9._-]{3,}$/.test(v), 'Username minimal 3 karakter: huruf, angka, titik, strip, atau garis bawah.'),
      password: z.string().min(12).max(72),
      employee_type: employeeType.default('karyawan'),
      areas: z.array(area).min(1).max(2).refine(v => new Set(v).size === v.length, 'Area tidak boleh duplikat.'),
    }).strict().parse(request.body);
    const hash = await hashPassword(input.password);
    const row = (await db.query(`INSERT INTO users(name,username,password_hash,role,areas,employee_type,approval_status)
      VALUES($1,$2,$3,'teknisi',$4::text[]::area_type[],$5,'menunggu')
      RETURNING id,name,username,employee_type,approval_status,areas::text[] AS areas,created_at`,
    [input.name, input.username, hash, input.areas, input.employee_type])).rows[0];
    return reply.code(201).send({ data: row });
  });
}
