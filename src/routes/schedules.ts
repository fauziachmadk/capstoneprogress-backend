import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db.js';
import type { Config } from '../config.js';
import { today } from '../config.js';
import { requireRole } from '../auth.js';
import { ApiError, assertExists } from '../errors.js';
import { area, date, id, pagination, paramId, status, text } from '../validation.js';
const scheduleInput = z.object({ office_id: id, area, scheduled_date: date, assigned_to: id.nullable().optional(), status: status.default('terjadwal') }).strict();
const schedulePatch = scheduleInput.partial().extend({ id: id.optional() }).strict().refine(v => Object.keys(v).some(k => k !== 'id'), 'Tidak ada perubahan.');
const officeInput = z.object({ code: text.transform(v => v.toUpperCase()), name: text, address: z.string().trim().max(1000).default(''), area: area.nullable().default(null) }).strict();
export function registerSchedules(app: FastifyInstance, db: Database, config: Config) {
  app.get('/api/users', async request => {
    requireRole(request, 'admin');
    const q = z.object({ ...pagination, role: z.enum(['admin', 'teknisi']).optional(), area: area.optional(), is_active: z.enum(['true','false']).optional() }).strict().parse(request.query);
    const values: any[] = [q.role ?? null, q.area ?? null];
    if (q.is_active !== undefined) values.push(q.is_active);
    const where = 'WHERE ($1::text IS NULL OR u.role::text=$1) AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM technician_areas WHERE user_id=u.id AND area::text=$2))' + (q.is_active !== undefined ? ' AND u.is_active=$3::boolean' : '');
    const total = Number((await db.query(`SELECT count(*) AS total FROM users u ${where}`, values)).rows[0].total);
    const users = (await db.query(`SELECT u.id,u.name,u.username,u.role,u.telegram_chat_id,u.is_active,u.created_at,u.updated_at,
      u.areas::text[] AS areas FROM users u
      ${where} ORDER BY u.name,u.id LIMIT $${values.length+1} OFFSET $${values.length+2}`, [...values, q.limit, (q.page - 1) * q.limit])).rows;
    return { data: users, meta: { page: q.page, limit: q.limit, total } };
  });
  app.get('/api/offices', async request => {
    const user = requireRole(request, 'admin', 'teknisi');
    const q = z.object({ ...pagination, area: area.optional(), search: z.string().trim().max(255).optional() }).strict().parse(request.query);
    const args = [q.area ?? null, q.search ? `%${q.search.replace(/[\\%_]/g, '\\$&')}%` : null, user.role === 'teknisi' ? user.id : null];
    const where = `WHERE ($1::text IS NULL OR o.area::text=$1) AND ($2::text IS NULL OR o.name ILIKE $2 OR o.code ILIKE $2)
      AND ($3::integer IS NULL OR EXISTS(SELECT 1 FROM mapping_schedules s WHERE s.office_id=o.id AND (s.assigned_to=$3 OR s.assigned_to IS NULL)
        AND EXISTS(SELECT 1 FROM technician_areas ta WHERE ta.user_id=$3 AND ta.area=s.area)))`;
    const total = Number((await db.query(`SELECT count(*) AS total FROM offices o ${where}`, args)).rows[0].total);
    const offices = (await db.query(`SELECT o.id,o.code,o.name,o.address,o.area FROM offices o ${where} ORDER BY o.name,o.id LIMIT $4 OFFSET $5`, [...args, q.limit, (q.page - 1) * q.limit])).rows;
    return { data: offices, meta: { page: q.page, limit: q.limit, total } };
  });
  app.post('/api/offices', async (request, reply) => {
    requireRole(request, 'admin'); const input = officeInput.parse(request.body);
    const row = (await db.query('INSERT INTO offices(code,name,address,area) VALUES($1,$2,$3,$4) RETURNING *', [input.code, input.name, input.address, input.area])).rows[0];
    return reply.code(201).send({ data: row });
  });
  app.get('/api/offices/:id', async request => {
    const user = requireRole(request,'admin','teknisi'); const officeId=paramId(request);
    const office=assertExists((await db.query('SELECT id,code,name,address,area,created_at FROM offices WHERE id=$1',[officeId])).rows[0]);
    if(user.role==='teknisi' && !(await db.query(`SELECT 1 FROM mapping_schedules s WHERE s.office_id=$1 AND (s.assigned_to=$2 OR s.assigned_to IS NULL)
      AND EXISTS(SELECT 1 FROM technician_areas ta WHERE ta.user_id=$2 AND ta.area=s.area) LIMIT 1`,[officeId,user.id])).rows.length) throw new ApiError(403,'FORBIDDEN','Kantor di luar penugasan.');
    return {data:office};
  });
  app.patch('/api/offices/:id', async request => {
    requireRole(request, 'admin'); const officeId = paramId(request);
    const input = officeInput.partial().refine(v => Object.keys(v).length > 0, 'Tidak ada perubahan.').parse(request.body);
    const updated = await db.transaction(async tx => {
      const office = assertExists((await tx.query('SELECT * FROM offices WHERE id=$1 FOR UPDATE', [officeId])).rows[0]);
      if (input.area !== undefined && input.area !== office.area && (await tx.query('SELECT 1 FROM mapping_schedules WHERE office_id=$1 LIMIT 1', [officeId])).rows.length) {
        throw new ApiError(409, 'OFFICE_AREA_IN_USE', 'Area kantor yang memiliki jadwal tidak dapat diubah.');
      }
      const keys = (['code', 'name', 'address', 'area'] as const).filter(k => input[k] !== undefined);
      return (await tx.query(`UPDATE offices SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(',')} WHERE id=$${keys.length + 1} RETURNING *`, [...keys.map(k => input[k]), officeId])).rows[0];
    });
    return { data: updated };
  });
  app.delete('/api/offices/:id', async (request, reply) => {
    requireRole(request, 'admin');
    assertExists((await db.query('DELETE FROM offices WHERE id=$1 RETURNING id', [paramId(request)])).rows[0]);
    return reply.code(204).send();
  });
  app.get('/api/schedules', async request => {
    const user = requireRole(request, 'admin', 'teknisi');
    const q = z.object({ ...pagination, office_id: id.optional(), assigned_to: id.optional(), status: status.optional(), date: date.optional(), area: area.optional() }).strict().parse(request.query);
    const technicianId = user.role === 'teknisi' ? user.id : q.assigned_to ?? null;
    if (user.role === 'teknisi' && q.assigned_to && q.assigned_to !== user.id) throw new ApiError(403, 'FORBIDDEN', 'Hanya jadwal sendiri yang dapat dibaca.');
    const args = [q.office_id ?? null, technicianId, q.status ?? null, q.date ?? (user.role==='teknisi' ? today(config.APP_TIMEZONE) : null), q.area ?? null, user.role === 'teknisi' ? user.id : null];
    const where = `WHERE ($1::integer IS NULL OR s.office_id=$1) AND ($2::integer IS NULL OR s.assigned_to=$2 OR ($6::integer IS NOT NULL AND s.assigned_to IS NULL))
      AND ($3::text IS NULL OR s.status::text=$3) AND ($4::date IS NULL OR s.scheduled_date=$4) AND ($5::text IS NULL OR s.area::text=$5)
      AND ($6::integer IS NULL OR (s.status<>'dibatalkan' AND EXISTS(SELECT 1 FROM technician_areas ta WHERE ta.user_id=$6 AND ta.area=s.area)))`;
    const total = Number((await db.query(`SELECT count(*) AS total FROM mapping_schedules s ${where}`, args)).rows[0].total);
    const rows = (await db.query(`SELECT s.id,s.office_id,s.area,s.scheduled_date::text,s.assigned_to,s.status,s.created_by,s.created_at,
      o.code AS office_code,o.name AS office_name,u.name AS technician_name FROM mapping_schedules s
      JOIN offices o ON o.id=s.office_id LEFT JOIN users u ON u.id=s.assigned_to ${where}
      ORDER BY s.scheduled_date,s.id LIMIT $7 OFFSET $8`, [...args, q.limit, (q.page - 1) * q.limit])).rows;
    return { data: rows, meta: { page: q.page, limit: q.limit, total } };
  });
  async function validateSchedule(tx: Database, value: z.infer<typeof scheduleInput>, checkDate: boolean) {
    if (checkDate && value.scheduled_date < today(config.APP_TIMEZONE)) throw new ApiError(422, 'PAST_DATE', 'Tanggal tidak boleh sebelum hari ini.');
    const office = assertExists((await tx.query('SELECT id,area FROM offices WHERE id=$1 FOR SHARE', [value.office_id])).rows[0], 'Kantor tidak ditemukan.');
    if (office.area !== null && office.area !== value.area) throw new ApiError(422, 'AREA_MISMATCH', 'Area jadwal harus sesuai kantor.');
    if (config.REQUIRE_SCHEDULE_ASSIGNEE && !value.assigned_to) throw new ApiError(422, 'ASSIGNEE_REQUIRED', 'Teknisi wajib ditugaskan.');
    if (value.assigned_to && !(await tx.query(`SELECT 1 FROM users u JOIN technician_areas ta ON ta.user_id=u.id
      WHERE u.id=$1 AND u.role='teknisi' AND u.is_active AND ta.area=$2`, [value.assigned_to, value.area])).rows.length) {
      throw new ApiError(422, 'TECHNICIAN_AREA_MISMATCH', 'Teknisi tidak melayani area jadwal.');
    }
  }
  app.post('/api/schedules', async (request, reply) => {
    const user = requireRole(request, 'admin'); const input = scheduleInput.parse(request.body);
    if (input.status !== 'terjadwal') throw new ApiError(422, 'INITIAL_STATUS_INVALID', 'Jadwal baru harus berstatus terjadwal.');
    const row = await db.transaction(async tx => {
      await validateSchedule(tx, input, true);
      return (await tx.query(`INSERT INTO mapping_schedules(office_id,area,scheduled_date,assigned_to,status,created_by)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [input.office_id, input.area, input.scheduled_date, input.assigned_to ?? null, input.status, user.id])).rows[0];
    });
    return reply.code(201).send({ data: row });
  });
  const update = async (request: FastifyRequest) => {
    requireRole(request, 'admin'); const input = schedulePatch.parse(request.body);
    const scheduleId = (request.params as { id?: string }).id ? paramId(request) : id.parse(input.id);
    if (input.id && input.id !== scheduleId) throw new ApiError(422, 'ID_MISMATCH', 'ID jadwal tidak sesuai.');
    const row = await db.transaction(async tx => {
      const old = assertExists((await tx.query('SELECT *,scheduled_date::text AS scheduled_date FROM mapping_schedules WHERE id=$1 FOR UPDATE', [scheduleId])).rows[0]);
      if (['selesai', 'dibatalkan'].includes(old.status)) throw new ApiError(409, 'SCHEDULE_CLOSED', 'Jadwal sudah ditutup.');
      if (old.status === 'berjalan' && input.status === 'terjadwal') throw new ApiError(409, 'INVALID_TRANSITION', 'Jadwal berjalan tidak dapat dikembalikan ke terjadwal.');
      const value = scheduleInput.parse({ office_id: input.office_id ?? old.office_id, area: input.area ?? old.area,
        scheduled_date: input.scheduled_date ?? old.scheduled_date,
        assigned_to: input.assigned_to === undefined ? old.assigned_to : input.assigned_to, status: input.status ?? old.status });
      const hasScans = (await tx.query('SELECT 1 FROM mapping_results WHERE schedule_id=$1 LIMIT 1', [scheduleId])).rows.length > 0;
      if (hasScans && (value.office_id !== old.office_id || value.area !== old.area || value.assigned_to !== old.assigned_to || value.scheduled_date !== old.scheduled_date)) {
        throw new ApiError(409, 'SCHEDULE_HAS_RESULTS', 'Kantor, area, tanggal, dan teknisi tidak dapat diganti setelah scan.');
      }
      await validateSchedule(tx, value, input.scheduled_date !== undefined);
      return (await tx.query(`UPDATE mapping_schedules SET office_id=$1,area=$2,scheduled_date=$3,assigned_to=$4,status=$5 WHERE id=$6 RETURNING *`,
        [value.office_id, value.area, value.scheduled_date, value.assigned_to ?? null, value.status, scheduleId])).rows[0];
    });
    return { data: row };
  };
  app.patch('/api/schedules', update);
  app.patch('/api/schedules/:id', update);
  const cancel = async (request: FastifyRequest) => {
    requireRole(request, 'admin');
    const scheduleId = (request.params as { id?: string }).id ? paramId(request) : z.object({ id }).strict().parse(request.query).id;
    const row = await db.transaction(async tx => {
      const old = assertExists((await tx.query('SELECT status FROM mapping_schedules WHERE id=$1 FOR UPDATE', [scheduleId])).rows[0]);
      if (old.status === 'selesai') throw new ApiError(409, 'SCHEDULE_CLOSED', 'Jadwal selesai tidak dapat dibatalkan.');
      return (await tx.query("UPDATE mapping_schedules SET status='dibatalkan' WHERE id=$1 RETURNING *", [scheduleId])).rows[0];
    });
    return { data: row };
  };
  app.delete('/api/schedules', cancel);
  app.delete('/api/schedules/:id', cancel);
}
