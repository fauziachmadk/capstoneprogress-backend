import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
export const id = z.union([z.number(), z.string().regex(/^[1-9]\d*$/).transform(Number)])
  .pipe(z.number().int().positive().max(2147483647));
export const text = z.string().trim().min(1).max(255);
export const area = z.enum(['grobogan', 'solo']);
export const status = z.enum(['terjadwal', 'berjalan', 'selesai', 'dibatalkan']);
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const parsed = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === v;
}, 'Tanggal tidak valid.');
export const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
};
export const assetFilters = z.object({
  ...pagination, search: z.string().trim().max(255).optional(), office_id: id.optional(),
  kind: z.enum(['chassis', 'module']).optional(), parent_id: id.optional(),
  mapping_status: z.enum(['belum', 'sudah', 'tidak_ditemukan']).optional(),
  schedule_id: id.optional(),
}).strict();
export function paramId(request: FastifyRequest): number { return z.object({ id }).parse(request.params).id; }
