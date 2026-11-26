import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db.js';
import { today, type Config } from '../config.js';
import { requireRole } from '../auth.js';
import { requireSchedule } from '../access.js';
import { ApiError, assertExists } from '../errors.js';
import { assetFilters, id, paramId, pagination, text } from '../validation.js';
import { assetExcelColumns, exportExcel, importAssets } from '../services/excel.js';
import { assertPhotoUrl } from './uploads.js';
export function assetWhere(filters: z.infer<typeof assetFilters>) {
  const clauses: string[] = []; const values: any[] = [];
  const add = (clause: string, value: any) => { values.push(value); clauses.push(clause.replaceAll('?', `$${values.length}`)); };
  if (filters.search) add("(a.eq ILIKE ? OR a.serial_number ILIKE ? OR a.asset_code ILIKE ?)", `%${filters.search.replace(/[\\%_]/g, '\\$&')}%`);
  if (filters.office_id) add('a.office_id=?', filters.office_id);
  if (filters.kind) add('a.kind=?', filters.kind);
  if (filters.parent_id) add('a.parent_id=?', filters.parent_id);
  if (filters.mapping_status) add('a.mapping_status=?', filters.mapping_status);
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}
const assetSelect = `SELECT a.id,a.eq,a.kind,a.parent_id,a.serial_number,a.ref,a.status,a.kondisi,a.kondisi AS condition,a.asset_code,
  a.office_id,a.mapping_status,a.label_status,a.label_code,a.photo_url,a.created_at,a.updated_at,o.code AS office_code,o.name AS office_name,
  p.serial_number AS parent_sn,
  (SELECT json_build_object('reason',r.reason,'rejected_by',coalesce(ru.name,''),'rejected_at',r.rejected_at)
    FROM mapping_rejections r LEFT JOIN users ru ON ru.id=r.rejected_by
    WHERE r.asset_id=a.id AND r.resolved_at IS NULL) AS rejection
  FROM assets a JOIN offices o ON o.id=a.office_id LEFT JOIN assets p ON p.id=a.parent_id`;
const kindFilter = z.enum(['chassis', 'module']);
// Aturan lapangan: modul baru bisa dipetakan setelah chassis induknya terverifikasi (mapping_status sudah).
// Modul tanpa induk tidak terkena aturan ini.
async function requireVerifiedChassis(tx: Database, assetId: number) {
  const parent = (await tx.query('SELECT p.id,p.eq,p.mapping_status FROM assets a JOIN assets p ON p.id=a.parent_id WHERE a.id=$1', [assetId])).rows[0];
  if (parent && parent.mapping_status !== 'sudah') {
    throw new ApiError(409, 'CHASSIS_NOT_VERIFIED', `Chassis induk ${parent.eq} belum terverifikasi. Scan chassis terlebih dahulu.`,
      { chassis_id: parent.id, chassis_eq: parent.eq, chassis_mapping_status: parent.mapping_status });
  }
}
// Kolom yang boleh dipakai untuk mengurutkan daftar aset admin (kunci = nilai parameter sort).
const assetSortColumns: Record<string, string> = {
  eq: 'a.eq', kind: 'a.kind', serial_number: 'a.serial_number', office: 'o.name', ref: 'a.ref', status: 'a.status',
  kondisi: 'a.kondisi', mapping_status: 'a.mapping_status', label_status: 'a.label_status', label_code: 'a.label_code',
};
// Satu kode label hanya boleh dipakai satu aset (label fisik tidak boleh ganda).
async function assertLabelFree(tx: Database, assetId: number, labelCode: string) {
  if ((await tx.query('SELECT 1 FROM assets WHERE label_code=$1 AND id<>$2 LIMIT 1', [labelCode, assetId])).rows.length) {
    throw new ApiError(409, 'LABEL_IN_USE', 'Kode label sudah dipakai aset lain.');
  }
}
export function registerAssets(app: FastifyInstance, db: Database, config: Config) {
  app.post('/api/assets', async (request, reply) => {
    const user = requireRole(request, 'admin');
    const field = z.string().trim().max(255);
    const input = z.object({ kind: z.enum(['chassis','module']), eq: text, serial_number: text.transform(v => v.toUpperCase()),
      office_id: id, parent_id: id.nullable().default(null), ref: field.default(''), status: field.default(''),
      kondisi: field.optional(), condition: field.optional(), asset_code: field.default('') }).strict()
      .refine(v => v.kondisi === undefined || v.condition === undefined || v.kondisi === v.condition, 'condition dan kondisi berbeda.').parse(request.body);
    if (input.kind === 'chassis' && input.parent_id) throw new ApiError(422, 'PARENT_INVALID', 'Chassis tidak boleh memiliki induk.');
    const asset = await db.transaction(async tx => {
      assertExists((await tx.query('SELECT id FROM offices WHERE id=$1', [input.office_id])).rows[0], 'Kantor tidak ditemukan.');
      return (await tx.query(`INSERT INTO assets(kind,parent_id,eq,serial_number,ref,status,kondisi,asset_code,office_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *,kondisi AS condition`,
      [input.kind,input.parent_id,input.eq,input.serial_number,input.ref,input.status,input.kondisi ?? input.condition ?? '',input.asset_code,input.office_id])).rows[0];
    }, user.id);
    return reply.code(201).send({ data: asset });
  });
  app.get('/api/assets/:id', async request => {
    requireRole(request, 'admin');
    return { data: assertExists((await db.query(`${assetSelect} WHERE a.id=$1`, [paramId(request)])).rows[0]) };
  });
  app.get('/api/assets', async request => {
    requireRole(request, 'admin');
    const filters = assetFilters.extend({ sort: z.enum(Object.keys(assetSortColumns) as [string, ...string[]]).optional(), dir: z.enum(['asc', 'desc']).default('asc') }).parse(request.query);
    const where = assetWhere(filters);
    // Kolom urut dari daftar putih (bukan input mentah); id sebagai pemisah supaya halaman stabil.
    const order = filters.sort ? `${assetSortColumns[filters.sort]} ${filters.dir === 'desc' ? 'DESC' : 'ASC'},a.id` : 'a.eq,a.id';
    const total = Number((await db.query(`SELECT count(*) AS total FROM assets a ${where.sql}`, where.values)).rows[0].total);
    const rows = (await db.query(`${assetSelect} ${where.sql} ORDER BY ${order} LIMIT $${where.values.length + 1} OFFSET $${where.values.length + 2}`, [...where.values, filters.limit, (filters.page - 1) * filters.limit])).rows;
    return { data: rows, meta: { page: filters.page, limit: filters.limit, total } };
  });
  // Kantor yang dapat dibuka teknisi, masing-masing dengan jadwal yang dipakai untuk membuka asetnya (jadwal aktif hari ini
  // bila ada, jika tidak jadwal terbaru yang tidak dibatalkan), apakah scan boleh dilakukan, dan jumlah aset per status.
  app.get('/api/technician/offices', async request => {
    const user = requireRole(request, 'teknisi');
    const rows = (await db.query(`SELECT o.id,o.code,o.name,o.address,o.area,sch.id AS schedule_id,sch.scheduled_date,sch.status AS schedule_status,sch.can_scan,
        ac.chassis,ac.modules,ac.total,ac.sudah,ac.belum,ac.tidak_ditemukan,ac.module_sudah,ac.module_belum,ac.module_tidak_ditemukan
      FROM offices o
      CROSS JOIN LATERAL (
        SELECT s.id,s.scheduled_date::text AS scheduled_date,s.status,(s.status IN ('terjadwal','berjalan') AND s.scheduled_date=$2::date) AS can_scan
        FROM mapping_schedules s
        WHERE s.office_id=o.id AND s.status<>'dibatalkan' AND (s.assigned_to=$1 OR s.assigned_to IS NULL)
          AND EXISTS(SELECT 1 FROM technician_areas ta WHERE ta.user_id=$1 AND ta.area=s.area)
        ORDER BY (s.status IN ('terjadwal','berjalan') AND s.scheduled_date=$2::date) DESC,s.scheduled_date DESC,s.id DESC LIMIT 1
      ) sch
      CROSS JOIN LATERAL (
        SELECT count(*) FILTER(WHERE a.kind='chassis')::int AS chassis,count(*) FILTER(WHERE a.kind='module')::int AS modules,count(*)::int AS total,
          count(*) FILTER(WHERE a.mapping_status='sudah')::int AS sudah,count(*) FILTER(WHERE a.mapping_status='belum')::int AS belum,
          count(*) FILTER(WHERE a.mapping_status='tidak_ditemukan')::int AS tidak_ditemukan,
          count(*) FILTER(WHERE a.kind='module' AND a.mapping_status='sudah')::int AS module_sudah,
          count(*) FILTER(WHERE a.kind='module' AND a.mapping_status='belum')::int AS module_belum,
          count(*) FILTER(WHERE a.kind='module' AND a.mapping_status='tidak_ditemukan')::int AS module_tidak_ditemukan
        FROM assets a WHERE a.office_id=o.id
      ) ac
      ORDER BY sch.can_scan DESC,o.name,o.id`, [user.id, today(config.APP_TIMEZONE)])).rows;
    return { data: rows };
  });
  app.get('/api/technician/assets', async request => {
    const user = requireRole(request, 'teknisi');
    const filters = assetFilters.extend({ schedule_id: id }).parse(request.query);
    const schedule = await requireSchedule(db, user, filters.schedule_id, config.APP_TIMEZONE);
    const where = assetWhere({ ...filters, office_id: schedule.office_id });
    const total = Number((await db.query(`SELECT count(*) AS total FROM assets a ${where.sql}`, where.values)).rows[0].total);
    const rows = (await db.query(`${assetSelect} ${where.sql} ORDER BY a.kind,a.eq LIMIT $${where.values.length + 1} OFFSET $${where.values.length + 2}`, [...where.values, filters.limit, (filters.page - 1) * filters.limit])).rows;
    return { data: rows, meta: { page: filters.page, limit: filters.limit, total } };
  });
  app.get('/api/technician/chassis', async request => {
    const user = requireRole(request, 'teknisi');
    const q = z.object({ ...pagination, schedule_id: id }).strict().parse(request.query);
    const schedule = await requireSchedule(db,user,q.schedule_id,config.APP_TIMEZONE);
    const data = (await db.query(`SELECT c.id,c.eq,c.serial_number,c.mapping_status,count(m.id)::int AS total_modules,
      count(m.id) FILTER(WHERE m.mapping_status='sudah')::int AS done_modules FROM assets c LEFT JOIN assets m ON m.parent_id=c.id
      WHERE c.kind='chassis' AND c.office_id=$1 GROUP BY c.id ORDER BY c.eq LIMIT $2 OFFSET $3`, [schedule.office_id,q.limit,(q.page-1)*q.limit])).rows;
    const total = Number((await db.query("SELECT count(*) AS n FROM assets WHERE kind='chassis' AND office_id=$1", [schedule.office_id])).rows[0].n);
    return { data,meta:{page:q.page,limit:q.limit,total} };
  });
  app.get('/api/technician/chassis/:id/modules', async request => {
    const user = requireRole(request, 'teknisi'); const chassisId = paramId(request);
    const q = z.object({ ...pagination, schedule_id: id }).strict().parse(request.query);
    const schedule = await requireSchedule(db,user,q.schedule_id,config.APP_TIMEZONE);
    const chassis = assertExists((await db.query("SELECT id,office_id FROM assets WHERE id=$1 AND kind='chassis'", [chassisId])).rows[0]);
    if (chassis.office_id !== schedule.office_id) throw new ApiError(403,'ASSET_FORBIDDEN','Aset di luar kantor penugasan.');
    const data = (await db.query(`${assetSelect} WHERE a.parent_id=$1 ORDER BY a.eq LIMIT $2 OFFSET $3`,[chassisId,q.limit,(q.page-1)*q.limit])).rows;
    const total = Number((await db.query('SELECT count(*) AS n FROM assets WHERE parent_id=$1',[chassisId])).rows[0].n);
    return {data,meta:{page:q.page,limit:q.limit,total}};
  });
  app.get('/api/assets/export', async (request, reply) => {
    requireRole(request, 'admin'); const where = assetWhere(assetFilters.parse(request.query));
    const rows = (await db.query(`${assetSelect} ${where.sql} ORDER BY a.eq LIMIT 10001`, where.values)).rows;
    if (rows.length > 10000) throw new ApiError(422, 'EXPORT_LIMIT', 'Ekspor maksimal 10.000 aset; persempit filter.');
    const buffer = await exportExcel(rows.map(r => ({ ...r, kind_label: r.kind === 'chassis' ? 'Chassis' : 'Modul' })), assetExcelColumns);
    return reply.header('Content-Disposition', 'attachment; filename="aset.xlsx"').type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buffer);
  });
  app.post('/api/assets/import', async (request, reply) => {
    const user = requireRole(request, 'admin');
    const { dry_run } = z.object({ dry_run: z.enum(['true', 'false']).default('true') }).strict().parse(request.query);
    const file = await request.file();
    if (!file || !file.filename.toLowerCase().endsWith('.xlsx')) throw new ApiError(422, 'INVALID_EXCEL', 'Unggah satu file XLSX.');
    const buffer = await file.toBuffer();
    const result = await importAssets(db, buffer, user.id, dry_run === 'true');
    return reply.code(dry_run === 'true' ? 200 : 201).send({ data: result });
  });
  app.get('/api/assets/:id/history', async request => {
    requireRole(request, 'admin'); const assetId = paramId(request);
    const q = z.object(pagination).strict().parse(request.query);
    assertExists((await db.query('SELECT id FROM assets WHERE id=$1', [assetId])).rows[0]);
    const rows = (await db.query(`SELECT h.id,h.field,h.old_value,h.new_value,h.changed_by,h.changed_at,u.name AS changed_by_name
      FROM asset_history h LEFT JOIN users u ON u.id=h.changed_by WHERE h.asset_id=$1 ORDER BY h.changed_at DESC,h.id LIMIT $2 OFFSET $3`, [assetId, q.limit, (q.page - 1) * q.limit])).rows;
    const total = Number((await db.query('SELECT count(*) AS total FROM asset_history WHERE asset_id=$1', [assetId])).rows[0].total);
    return { data: rows, meta: { ...q, total } };
  });
  app.patch('/api/assets/:id', async request => {
    const user = requireRole(request, 'admin', 'teknisi'); const assetId = paramId(request);
    const field = z.string().trim().max(255).nullable().transform(v => v ?? '');
    const parsed = z.object({ ref: field.optional(), status: field.optional(), kondisi: field.optional(), condition: field.optional(), label_code: text.optional(), schedule_id: id.optional() }).strict()
      .refine(v => ['ref', 'status', 'kondisi','condition','label_code'].some(k => k in v), 'Tidak ada perubahan.')
      .refine(v => v.kondisi === undefined || v.condition === undefined || v.kondisi === v.condition, 'condition dan kondisi berbeda.').parse(request.body);
    const input = {...parsed,kondisi:parsed.kondisi ?? parsed.condition};
    if (user.role === 'teknisi' && input.kondisi !== undefined && !config.TECHNICIAN_CAN_EDIT_CONDITION) throw new ApiError(403, 'CONDITION_FORBIDDEN', 'Perubahan kondisi hanya untuk admin.');
    const updated = await db.transaction(async tx => {
      let schedule;
      if (user.role === 'teknisi') {
        if (!input.schedule_id) throw new ApiError(422, 'SCHEDULE_REQUIRED', 'schedule_id wajib untuk teknisi.');
        schedule = await requireSchedule(tx, user, input.schedule_id, config.APP_TIMEZONE, true);
      }
      const asset = assertExists((await tx.query('SELECT id,office_id FROM assets WHERE id=$1 FOR UPDATE', [assetId])).rows[0]);
      if (schedule && schedule.office_id !== asset.office_id) throw new ApiError(403, 'ASSET_FORBIDDEN', 'Aset di luar kantor penugasan.');
      const keys = (['ref', 'status', 'kondisi'] as const).filter(k => input[k] !== undefined);
      const values: any[] = keys.map(k => input[k]); const sets = keys.map((k, i) => `${k}=$${i + 1}`);
      // Memperbarui kode label (tanpa scan) menandai label terpasang; kodenya harus unik.
      if (input.label_code !== undefined) {
        await assertLabelFree(tx, assetId, input.label_code);
        values.push(input.label_code); sets.push(`label_code=$${values.length}`, "label_status='terpasang'");
      }
      values.push(assetId);
      return (await tx.query(`UPDATE assets SET ${sets.join(',')} WHERE id=$${values.length} RETURNING *,kondisi AS condition`, values)).rows[0];
    }, user.id);
    return { data: updated };
  });
  app.post('/api/scan/match', async request => {
    const user = requireRole(request, 'teknisi');
    const input = z.object({ serial_number: text.transform(v => v.toUpperCase()), schedule_id: id, kind: kindFilter.optional() }).strict().parse(request.body);
    const schedule = await requireSchedule(db, user, input.schedule_id, config.APP_TIMEZONE, true);
    // kind (opsional) membatasi pencocokan ke chassis atau modul; tanpa kind semua jenis dicocokkan.
    const assets = (await db.query(`${assetSelect} WHERE a.serial_number=$1 AND a.office_id=$2 AND ($3::text IS NULL OR a.kind::text=$3) ORDER BY a.eq`,
      [input.serial_number, schedule.office_id, input.kind ?? null])).rows;
    return { data: { result: assets.length === 0 ? 'not_found' : assets.length === 1 ? 'found' : 'multiple', assets } };
  });
  app.post('/api/mapping-results', async (request, reply) => {
    const user = requireRole(request, 'teknisi');
    const input = z.object({ schedule_id: id, scanned_sn: text.transform(v => v.toUpperCase()), asset_id: id.nullable().optional(),
      label_attached: z.boolean().default(false), label_code: text.optional(), photo_url: z.string().trim().min(1).max(500).optional(), kind: kindFilter.optional() }).strict().parse(request.body);
    // Foto opsional di API (frontend yang mewajibkan); jika ada, harus URL Cloudinary proyek ini.
    const photoUrl = input.photo_url === undefined ? null : assertPhotoUrl(config, input.photo_url);
    const result = await db.transaction(async tx => {
      const schedule = await requireSchedule(tx, user, input.schedule_id, config.APP_TIMEZONE, true);
      const matches = (await tx.query('SELECT id FROM assets WHERE serial_number=$1 AND office_id=$2 AND ($3::text IS NULL OR kind::text=$3) ORDER BY id FOR UPDATE',
        [input.scanned_sn, schedule.office_id, input.kind ?? null])).rows;
      const matchResult = matches.length === 0 ? 'not_found' : matches.length === 1 ? 'found' : 'multiple';
      const assetId = input.asset_id ?? (matches.length === 1 ? matches[0].id : null);
      if (input.asset_id && matchResult === 'not_found') {
        const expected=assertExists((await tx.query('SELECT id,office_id,kind FROM assets WHERE id=$1 FOR UPDATE',[input.asset_id])).rows[0]);
        if(expected.office_id!==schedule.office_id) throw new ApiError(403,'ASSET_FORBIDDEN','Aset di luar kantor penugasan.');
        if(input.kind && expected.kind!==input.kind) throw new ApiError(422,'ASSET_MISMATCH','Jenis aset tidak sesuai dengan kind yang dipindai.');
      } else if (input.asset_id && !matches.some(a => a.id === input.asset_id)) throw new ApiError(422, 'ASSET_MISMATCH', 'Aset pilihan tidak cocok dengan SN dan kantor.');
      if (assetId) await requireVerifiedChassis(tx, assetId);
      if (assetId && input.label_code) await assertLabelFree(tx, assetId, input.label_code);
      if(matchResult==='not_found' && (input.label_attached || input.label_code)) throw new ApiError(422,'LABEL_INVALID','Hasil tidak ditemukan tidak dapat memasang label.');
      if ((input.label_attached || input.label_code) && !assetId) throw new ApiError(422, 'ASSET_REQUIRED', 'Pilih aset sebelum memasang label.');
      if (input.label_code && !input.label_attached) throw new ApiError(422, 'LABEL_INVALID', 'Kode label memerlukan label_attached=true.');
      const scan = (await tx.query(`INSERT INTO mapping_results(schedule_id,asset_id,scanned_sn,result,scanned_by,label_attached,photo_url)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [input.schedule_id, assetId, input.scanned_sn, matchResult, user.id, input.label_attached, photoUrl])).rows[0];
      if (assetId && matchResult==='not_found') await tx.query("UPDATE assets SET mapping_status='tidak_ditemukan' WHERE id=$1",[assetId]);
      else if (assetId) await tx.query(`UPDATE assets SET mapping_status='sudah',
        label_status=CASE WHEN $2 THEN 'terpasang' ELSE label_status END,
        label_code=coalesce($3,label_code),photo_url=coalesce($4,photo_url) WHERE id=$1`, [assetId, input.label_attached, input.label_code ?? null, photoUrl]);
      // Mapping ulang menyelesaikan penolakan admin yang masih aktif.
      if (assetId && matchResult !== 'not_found') await tx.query('UPDATE mapping_rejections SET resolved_at=now() WHERE asset_id=$1 AND resolved_at IS NULL', [assetId]);
      await tx.query("UPDATE mapping_schedules SET status='berjalan' WHERE id=$1 AND status='terjadwal'", [input.schedule_id]);
      return scan;
    }, user.id);
    return reply.code(201).send({ data: { ...result, scanned_by_name: user.name } });
  });
  // A missing expected asset has a known ID; an unmatched SN has no asset ID.
  app.post('/api/assets/:id/not-found', async request => {
    const user = requireRole(request, 'teknisi'); const assetId = paramId(request);
    const input = z.object({ schedule_id: id }).strict().parse(request.body);
    const result = await db.transaction(async tx => {
      const schedule = await requireSchedule(tx, user, input.schedule_id, config.APP_TIMEZONE, true);
      const asset = assertExists((await tx.query('SELECT id,office_id FROM assets WHERE id=$1 FOR UPDATE', [assetId])).rows[0]);
      if (asset.office_id !== schedule.office_id) throw new ApiError(403, 'ASSET_FORBIDDEN', 'Aset di luar kantor penugasan.');
      await requireVerifiedChassis(tx, assetId);
      return (await tx.query("UPDATE assets SET mapping_status='tidak_ditemukan' WHERE id=$1 RETURNING *", [assetId])).rows[0];
    }, user.id);
    return { data: result };
  });
  // Membatalkan tanda "tidak ditemukan": aset kembali belum termapping (mis. ternyata ditemukan kemudian).
  app.post('/api/assets/:id/reset', async request => {
    const user = requireRole(request, 'teknisi'); const assetId = paramId(request);
    const input = z.object({ schedule_id: id }).strict().parse(request.body);
    const result = await db.transaction(async tx => {
      const schedule = await requireSchedule(tx, user, input.schedule_id, config.APP_TIMEZONE, true);
      const asset = assertExists((await tx.query('SELECT id,office_id,mapping_status FROM assets WHERE id=$1 FOR UPDATE', [assetId])).rows[0]);
      if (asset.office_id !== schedule.office_id) throw new ApiError(403, 'ASSET_FORBIDDEN', 'Aset di luar kantor penugasan.');
      if (asset.mapping_status !== 'tidak_ditemukan') throw new ApiError(409, 'NOT_MARKED', 'Hanya aset yang ditandai tidak ditemukan yang dapat dikembalikan.');
      return (await tx.query("UPDATE assets SET mapping_status='belum' WHERE id=$1 RETURNING *", [assetId])).rows[0];
    }, user.id);
    return { data: result };
  });
  // Admin menolak hasil mapping: aset kembali 'belum' supaya teknisi mengulang. Foto dan label lama dipertahankan.
  app.post('/api/assets/:id/reject', async request => {
    const user = requireRole(request, 'admin'); const assetId = paramId(request);
    const input = z.object({ reason: z.string().trim().min(1).max(500) }).strict().parse(request.body);
    await db.transaction(async tx => {
      const asset = assertExists((await tx.query('SELECT id,mapping_status FROM assets WHERE id=$1 FOR UPDATE', [assetId])).rows[0]);
      if (asset.mapping_status !== 'sudah') throw new ApiError(409, 'NOT_MAPPED', 'Hanya mapping yang sudah selesai yang dapat ditolak.');
      await tx.query("UPDATE assets SET mapping_status='belum' WHERE id=$1", [assetId]);
      await tx.query('INSERT INTO mapping_rejections(asset_id,reason,rejected_by) VALUES($1,$2,$3)', [assetId, input.reason, user.id]);
    }, user.id);
    return { data: assertExists((await db.query(`${assetSelect} WHERE a.id=$1`, [assetId])).rows[0]) };
  });
}
