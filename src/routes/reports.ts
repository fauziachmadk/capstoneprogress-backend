import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db.js';
import { requireRole } from '../auth.js';
import { ApiError } from '../errors.js';
import { area, date, id, pagination } from '../validation.js';
import { exportExcel } from '../services/excel.js';
import { today, type Config } from '../config.js';
const filters = z.object({ ...pagination, office_id: id.optional(), schedule_id: id.optional(), date_from: date.optional(), date_to: date.optional(),
  result: z.enum(['found', 'not_found', 'multiple']).optional() }).strict()
  .refine(v => !v.date_from || !v.date_to || v.date_from <= v.date_to, 'Rentang tanggal tidak valid.');
const reportSelect = `SELECT r.id,r.schedule_id,r.asset_id,r.scanned_sn,r.result,r.scanned_by,r.scanned_at,r.label_attached,
  s.scheduled_date::text,o.code AS office_code,o.name AS office_name,u.name AS technician_name,a.eq,a.kind,a.ref,a.status,a.kondisi
  FROM mapping_results r JOIN mapping_schedules s ON s.id=r.schedule_id JOIN offices o ON o.id=s.office_id
  JOIN users u ON u.id=r.scanned_by LEFT JOIN assets a ON a.id=r.asset_id`;
export function registerReports(app: FastifyInstance, db: Database,config:Config) {
  app.get('/api/dashboard/summary',async request=>{
    requireRole(request,'admin');
    const summary=(await db.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE mapping_status='sudah')::int AS sudah,
      count(*) FILTER(WHERE mapping_status='belum')::int AS belum,count(*) FILTER(WHERE mapping_status='tidak_ditemukan')::int AS tidak_ditemukan FROM assets`)).rows[0];
    // "Hari ini" mengikuti APP_TIMEZONE: hasil scan dan perubahan REF/STATUS pada tanggal lokal itu.
    const args=[config.APP_TIMEZONE,today(config.APP_TIMEZONE)];
    const scans=(await db.query(`SELECT count(*) FILTER(WHERE result='found')::int AS found,count(*) FILTER(WHERE result='not_found')::int AS not_found,
      count(*) FILTER(WHERE result='multiple')::int AS multiple FROM mapping_results WHERE (scanned_at AT TIME ZONE $1)::date=$2::date`,args)).rows[0];
    const changes=(await db.query(`SELECT count(*) FILTER(WHERE field='ref')::int AS ref_changes,count(*) FILTER(WHERE field='status')::int AS status_changes
      FROM asset_history WHERE (changed_at AT TIME ZONE $1)::date=$2::date`,args)).rows[0];
    return {data:{...summary,percent:summary.total?Math.round(100*summary.sudah/summary.total):0,today:{...scans,...changes}}};
  });
  app.get('/api/dashboard/progress', async request => {
    requireRole(request, 'admin');
    const q = z.object({ ...pagination, area: area.optional(), office_id: id.optional() }).strict().parse(request.query);
    const args = [q.area ?? null, q.office_id ?? null];
    const where = 'WHERE ($1::text IS NULL OR o.area::text=$1) AND ($2::integer IS NULL OR o.id=$2)';
    const total = Number((await db.query(`SELECT count(*) AS total FROM offices o ${where}`, args)).rows[0].total);
    // Jadwal terdekat, aktivitas scan terakhir, dan keadaan jadwal per kantor dihitung sekali per kantor (tanpa query per baris).
    const rows = (await db.query(`SELECT o.id,o.code,o.name,o.area,ac.total,ac.sudah,ac.belum,ac.tidak_ditemukan,ac.labels_attached,
      sc.next_date::text AS next_date,sc.has_running,sc.has_done,ls.last_activity
      FROM offices o
      CROSS JOIN LATERAL (SELECT count(*)::int AS total,
        count(*) FILTER(WHERE a.mapping_status='sudah')::int AS sudah,
        count(*) FILTER(WHERE a.mapping_status='belum')::int AS belum,
        count(*) FILTER(WHERE a.mapping_status='tidak_ditemukan')::int AS tidak_ditemukan,
        count(*) FILTER(WHERE a.label_status='terpasang')::int AS labels_attached
        FROM assets a WHERE a.office_id=o.id) ac
      CROSS JOIN LATERAL (SELECT min(s.scheduled_date) FILTER(WHERE s.status='terjadwal' AND s.scheduled_date>=$5::date) AS next_date,
        coalesce(bool_or(s.status='berjalan'),false) AS has_running,coalesce(bool_or(s.status='selesai'),false) AS has_done
        FROM mapping_schedules s WHERE s.office_id=o.id) sc
      CROSS JOIN LATERAL (SELECT max(r.scanned_at) AS last_activity FROM mapping_results r
        JOIN mapping_schedules s ON s.id=r.schedule_id WHERE s.office_id=o.id) ls
      ${where} ORDER BY o.name,o.id LIMIT $3 OFFSET $4`, [...args, q.limit, (q.page - 1) * q.limit, today(config.APP_TIMEZONE)])).rows;
    return { data: rows.map(({ has_running, has_done, ...r }) => ({ ...r,done:r.sudah,percent:r.total?Math.round(100*r.sudah/r.total):0,
      progress_percent: r.total ? Math.round(10000 * (r.sudah + r.tidak_ditemukan) / r.total) / 100 : 0,
      schedule_state: has_running ? 'berjalan' : r.next_date ? 'terjadwal' : has_done ? 'selesai' : 'belum' })), meta: { page: q.page, limit: q.limit, total } };
  });
  for (const isExport of [false, true]) {
    app.get(isExport ? '/api/reports/mapping/export' : '/api/reports/mapping', async (request, reply) => {
      requireRole(request, 'admin'); const q = filters.parse(request.query);
      const args = [q.office_id ?? null, q.schedule_id ?? null, q.date_from ?? null, q.date_to ?? null,config.APP_TIMEZONE, q.result ?? null];
      const where = `WHERE ($1::integer IS NULL OR s.office_id=$1) AND ($2::integer IS NULL OR s.id=$2)
        AND ($3::date IS NULL OR (r.scanned_at AT TIME ZONE $5)::date >= $3) AND ($4::date IS NULL OR (r.scanned_at AT TIME ZONE $5)::date <= $4)
        AND ($6::text IS NULL OR r.result::text=$6)`;
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
      const rows = (await db.query(`${reportSelect} ${where} ORDER BY r.scanned_at DESC,r.id LIMIT $7 OFFSET $8`, [...args, q.limit, (q.page - 1) * q.limit])).rows;
      return { data: rows, meta: { page: q.page, limit: q.limit, total } };
    });
  }
}
