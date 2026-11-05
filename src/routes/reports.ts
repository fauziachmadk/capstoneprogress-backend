import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db.js';
import { requireRole } from '../auth.js';
import { ApiError } from '../errors.js';
import { area, date, id, pagination } from '../validation.js';
import { exportExcel } from '../services/excel.js';
import type { Config } from '../config.js';
const filters = z.object({ ...pagination, office_id: id.optional(), schedule_id: id.optional(), date_from: date.optional(), date_to: date.optional() }).strict()
  .refine(v => !v.date_from || !v.date_to || v.date_from <= v.date_to, 'Rentang tanggal tidak valid.');
const reportSelect = `SELECT r.id,r.schedule_id,r.asset_id,r.scanned_sn,r.result,r.scanned_by,r.scanned_at,r.label_attached,
  s.scheduled_date::text,o.code AS office_code,o.name AS office_name,u.name AS technician_name,a.eq,a.kind,a.ref,a.status,a.kondisi
  FROM mapping_results r JOIN mapping_schedules s ON s.id=r.schedule_id JOIN offices o ON o.id=s.office_id
  JOIN users u ON u.id=r.scanned_by LEFT JOIN assets a ON a.id=r.asset_id`;
export function registerReports(app: FastifyInstance, db: Database,config:Config) {
  app.get('/api/dashboard/summary',async request=>{
    requireRole(request,'admin');
    return {data:(await db.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE mapping_status='sudah')::int AS sudah,
      count(*) FILTER(WHERE mapping_status='belum')::int AS belum,count(*) FILTER(WHERE mapping_status='tidak_ditemukan')::int AS tidak_ditemukan FROM assets`)).rows[0]};
  });
  app.get('/api/dashboard/progress', async request => {
    requireRole(request, 'admin');
    const q = z.object({ ...pagination, area: area.optional(), office_id: id.optional() }).strict().parse(request.query);
    const args = [q.area ?? null, q.office_id ?? null];
    const where = 'WHERE ($1::text IS NULL OR o.area::text=$1) AND ($2::integer IS NULL OR o.id=$2)';
    const total = Number((await db.query(`SELECT count(*) AS total FROM offices o ${where}`, args)).rows[0].total);
    const rows = (await db.query(`SELECT o.id,o.code,o.name,o.area,count(a.id)::int AS total,
      count(a.id) FILTER(WHERE a.mapping_status='sudah')::int AS sudah,
      count(a.id) FILTER(WHERE a.mapping_status='belum')::int AS belum,
      count(a.id) FILTER(WHERE a.mapping_status='tidak_ditemukan')::int AS tidak_ditemukan,
      count(a.id) FILTER(WHERE a.label_status='terpasang')::int AS labels_attached
      FROM offices o LEFT JOIN assets a ON a.office_id=o.id ${where} GROUP BY o.id ORDER BY o.name,o.id LIMIT $3 OFFSET $4`, [...args, q.limit, (q.page - 1) * q.limit])).rows;
    return { data: rows.map(r => ({ ...r,done:r.sudah,percent:r.total?Math.round(100*r.sudah/r.total):0,
      progress_percent: r.total ? Math.round(10000 * (r.sudah + r.tidak_ditemukan) / r.total) / 100 : 0 })), meta: { page: q.page, limit: q.limit, total } };
  });
  for (const isExport of [false, true]) {
    app.get(isExport ? '/api/reports/mapping/export' : '/api/reports/mapping', async (request, reply) => {
      requireRole(request, 'admin'); const q = filters.parse(request.query);
      const args = [q.office_id ?? null, q.schedule_id ?? null, q.date_from ?? null, q.date_to ?? null,config.APP_TIMEZONE];
      const where = `WHERE ($1::integer IS NULL OR s.office_id=$1) AND ($2::integer IS NULL OR s.id=$2)
        AND ($3::date IS NULL OR (r.scanned_at AT TIME ZONE $5)::date >= $3) AND ($4::date IS NULL OR (r.scanned_at AT TIME ZONE $5)::date <= $4)`;
      if (isExport) {
        const rows = (await db.query(`${reportSelect} ${where} ORDER BY r.scanned_at,r.id LIMIT 10001`, args)).rows;
        if (rows.length > 10000) throw new ApiError(422, 'EXPORT_LIMIT', 'Ekspor maksimal 10.000 scan; persempit filter.');
        const columns = [{ header: 'Tanggal Jadwal', key: 'scheduled_date' }, { header: 'Kantor', key: 'office_name' },
          { header: 'Teknisi', key: 'technician_name' }, { header: 'SN Scan', key: 'scanned_sn' }, { header: 'EQ', key: 'eq' },
          { header: 'Hasil', key: 'result' }, { header: 'Label Terpasang', key: 'label_attached' }, { header: 'Waktu Scan', key: 'scanned_at' }];
        return reply.header('Content-Disposition', 'attachment; filename="laporan-mapping.xlsx"')
          .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(await exportExcel(rows, columns));
      }
      const total = Number((await db.query(`SELECT count(*) AS total FROM mapping_results r JOIN mapping_schedules s ON s.id=r.schedule_id ${where}`, args)).rows[0].total);
      const rows = (await db.query(`${reportSelect} ${where} ORDER BY r.scanned_at DESC,r.id LIMIT $6 OFFSET $7`, [...args, q.limit, (q.page - 1) * q.limit])).rows;
      return { data: rows, meta: { page: q.page, limit: q.limit, total } };
    });
  }
}
