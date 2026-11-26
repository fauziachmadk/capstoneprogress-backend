import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db.js';
import { requireRole } from '../auth.js';
import { assertExists } from '../errors.js';
import { date, id, pagination, paramId } from '../validation.js';

// Master inventaris (hanya baca): jenis perangkat, site, dan aset hasil impor CSV. Khusus admin.
const like = (value?: string) => value ? `%${value.replace(/[\\%_]/g, '\\$&')}%` : null;
const search = z.string().trim().max(255).optional();

const itemSelect = `SELECT i.id,i.equipment_id,i.inventory_number,i.nka,i.nka_acq_date::text AS nka_acq_date,i.serial_number,i.superior_equipment,i.remarks,
  i.type_id,t.name AS type_name,t.category,t.object_type,t.manufacturer,t.model,t.part_number,
  i.site_id,s.code AS site_code,s.name AS site_name,s.functional_location
  FROM asset_inventory i JOIN equipment_types t ON t.id=i.type_id JOIN inventory_sites s ON s.id=i.site_id`;

export function registerInventory(app: FastifyInstance, db: Database) {
  app.get('/api/equipment-types', async request => {
    requireRole(request, 'admin');
    const q = z.object({ ...pagination, search }).strict().parse(request.query);
    const args = [like(q.search)];
    const where = 'WHERE ($1::text IS NULL OR t.name ILIKE $1 OR t.category ILIKE $1 OR t.manufacturer ILIKE $1 OR t.model ILIKE $1)';
    const total = Number((await db.query(`SELECT count(*) AS total FROM equipment_types t ${where}`, args)).rows[0].total);
    const rows = (await db.query(`SELECT t.id,t.name,t.category,t.object_type,t.manufacturer,t.model,t.part_number,count(i.id)::int AS items
      FROM equipment_types t LEFT JOIN asset_inventory i ON i.type_id=t.id ${where} GROUP BY t.id ORDER BY t.name,t.id LIMIT $2 OFFSET $3`,
    [...args, q.limit, (q.page - 1) * q.limit])).rows;
    return { data: rows, meta: { page: q.page, limit: q.limit, total } };
  });

  app.get('/api/inventory-sites', async request => {
    requireRole(request, 'admin');
    const q = z.object({ ...pagination, search }).strict().parse(request.query);
    const args = [like(q.search)];
    const where = 'WHERE ($1::text IS NULL OR s.code ILIKE $1 OR s.name ILIKE $1 OR s.functional_location ILIKE $1)';
    const total = Number((await db.query(`SELECT count(*) AS total FROM inventory_sites s ${where}`, args)).rows[0].total);
    const rows = (await db.query(`SELECT s.id,s.code,s.name,s.functional_location,s.description,s.territory,s.regional_code,s.regional_name,
      s.district_code,s.district_name,s.cost_center,s.maintenance_plant,s.work_center,count(i.id)::int AS items
      FROM inventory_sites s LEFT JOIN asset_inventory i ON i.site_id=s.id ${where} GROUP BY s.id ORDER BY s.code,s.id LIMIT $2 OFFSET $3`,
    [...args, q.limit, (q.page - 1) * q.limit])).rows;
    return { data: rows, meta: { page: q.page, limit: q.limit, total } };
  });

  app.get('/api/inventory', async request => {
    requireRole(request, 'admin');
    const q = z.object({ ...pagination, search, type_id: id.optional(), site_id: id.optional(),
      site_code: z.string().trim().min(1).max(50).transform(v => v.toUpperCase()).optional(), category: z.string().trim().min(1).max(255).optional(),
      object_type: z.string().trim().min(1).max(255).optional(), date_from: date.optional(), date_to: date.optional() }).strict()
      .refine(v => !v.date_from || !v.date_to || v.date_from <= v.date_to, 'Rentang tanggal tidak valid.').parse(request.query);
    const args = [like(q.search), q.type_id ?? null, q.site_id ?? null, q.site_code ?? null, q.category ?? null, q.object_type ?? null, q.date_from ?? null, q.date_to ?? null];
    const where = `WHERE ($1::text IS NULL OR i.equipment_id ILIKE $1 OR i.inventory_number ILIKE $1 OR i.nka ILIKE $1 OR i.serial_number ILIKE $1)
      AND ($2::integer IS NULL OR i.type_id=$2) AND ($3::integer IS NULL OR i.site_id=$3) AND ($4::text IS NULL OR s.code=$4)
      AND ($5::text IS NULL OR lower(t.category)=lower($5)) AND ($6::text IS NULL OR lower(t.object_type)=lower($6))
      AND ($7::date IS NULL OR i.nka_acq_date>=$7) AND ($8::date IS NULL OR i.nka_acq_date<=$8)`;
    const from = 'FROM asset_inventory i JOIN equipment_types t ON t.id=i.type_id JOIN inventory_sites s ON s.id=i.site_id';
    const total = Number((await db.query(`SELECT count(*) AS total ${from} ${where}`, args)).rows[0].total);
    const rows = (await db.query(`${itemSelect} ${where} ORDER BY s.code,t.name,i.equipment_id,i.id LIMIT $9 OFFSET $10`,
      [...args, q.limit, (q.page - 1) * q.limit])).rows;
    return { data: rows, meta: { page: q.page, limit: q.limit, total } };
  });

  app.get('/api/inventory/:id', async request => {
    requireRole(request, 'admin');
    const row = assertExists((await db.query(`SELECT i.id,i.equipment_id,i.inventory_number,i.nka,i.nka_acq_date::text AS nka_acq_date,i.serial_number,
      i.superior_equipment,i.remarks,i.created_at,i.updated_at,
      json_build_object('id',t.id,'name',t.name,'category',t.category,'object_type',t.object_type,'manufacturer',t.manufacturer,'model',t.model,'part_number',t.part_number) AS type,
      json_build_object('id',s.id,'code',s.code,'name',s.name,'functional_location',s.functional_location,'description',s.description,'territory',s.territory,
        'regional_code',s.regional_code,'regional_name',s.regional_name,'district_code',s.district_code,'district_name',s.district_name,
        'cost_center',s.cost_center,'maintenance_plant',s.maintenance_plant,'work_center',s.work_center) AS site
      FROM asset_inventory i JOIN equipment_types t ON t.id=i.type_id JOIN inventory_sites s ON s.id=i.site_id WHERE i.id=$1`, [paramId(request)])).rows[0]);
    return { data: row };
  });
}
