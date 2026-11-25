import type { Database } from '../db.js';
import type { Issue } from './inventory-import.js';

// Membuat kantor dan aset kerja dari master inventaris.
//  - Satu inventory_sites -> satu offices (kode = kode site, area tetap 'solo': seluruh site master ada di Surakarta).
//  - Satu asset_inventory -> satu assets (eq = Equipment ID, jenis 'module' tanpa induk, status mapping/label 'belum').
// Kunci upsert: offices.site_id dan assets.inventory_id. Status kerja yang sudah ada tidak pernah ditimpa. Aman dijalankan ulang.

export const SYNC_AREA = 'solo';

export interface SyncResult {
  dryRun: boolean;
  offices: { inserted: number; updated: number };
  assets: { inserted: number; updated: number };
}
export class SyncConflictError extends Error {
  constructor(public issues: Issue[]) { super(`Tabrakan dengan data kerja yang sudah ada (${issues.length} masalah).`); }
}

type Site = { id: number; code: string; name: string; description: string };
type Item = { id: number; equipment_id: string; serial_number: string; site_id: number };

// Kode kantor atau EQ yang sudah dipakai kantor/aset lain yang bukan hasil sinkron dari baris master yang sama.
async function findConflicts(db: Database, sites: Site[], items: Item[]): Promise<Issue[]> {
  const issues: Issue[] = [];
  const siteById = new Map(sites.map(s => [s.id, s]));
  for (const o of (await db.query<{ code: string; site_id: number | null }>('SELECT code,site_id FROM offices WHERE code=ANY($1::text[])', [sites.map(s => s.code)])).rows) {
    const site = sites.find(s => s.code === o.code)!;
    if (o.site_id !== site.id) issues.push({ line: site.id, message: `Kode kantor "${o.code}" sudah dipakai kantor lain yang bukan dari site ini` });
  }
  for (const a of (await db.query<{ eq: string; inventory_id: number | null }>('SELECT eq,inventory_id FROM assets WHERE eq=ANY($1::text[])', [items.map(i => i.equipment_id)])).rows) {
    const item = items.find(i => i.equipment_id === a.eq)!;
    if (a.inventory_id !== item.id) issues.push({ line: item.id, message: `EQ "${a.eq}" sudah dipakai aset lain yang bukan dari master (site ${siteById.get(item.site_id)?.code})` });
  }
  return issues;
}

export async function syncInventory(db: Database, dryRun: boolean): Promise<SyncResult> {
  const run = async (tx: Database): Promise<SyncResult> => {
    const sites = (await tx.query<Site>('SELECT id,code,name,description FROM inventory_sites ORDER BY id')).rows;
    const items = (await tx.query<Item>('SELECT id,equipment_id,serial_number,site_id FROM asset_inventory ORDER BY id')).rows;
    const conflicts = await findConflicts(tx, sites, items);
    if (conflicts.length) throw new SyncConflictError(conflicts);
    const result: SyncResult = { dryRun, offices: { inserted: 0, updated: 0 }, assets: { inserted: 0, updated: 0 } };
    if (dryRun) {
      // Hitung tanpa menulis, supaya urutan ID tidak terbuang.
      const o = Number((await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM offices WHERE site_id=ANY($1::int[])', [sites.map(s => s.id)])).rows[0].n);
      const a = Number((await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM assets WHERE inventory_id=ANY($1::int[])', [items.map(i => i.id)])).rows[0].n);
      result.offices = { inserted: sites.length - o, updated: o }; result.assets = { inserted: items.length - a, updated: a };
      return result;
    }
    const officeIds = new Map<number, number>();
    for (const s of sites) {
      const r = (await tx.query<{ id: number; inserted: boolean }>(`INSERT INTO offices(code,name,address,area,site_id) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(site_id) DO UPDATE SET code=excluded.code,name=excluded.name,address=excluded.address,area=excluded.area RETURNING id,(xmax=0) AS inserted`,
      [s.code, s.name, s.description, SYNC_AREA, s.id])).rows[0];
      officeIds.set(s.id, r.id); result.offices[r.inserted ? 'inserted' : 'updated']++;
    }
    // Status mapping, label, REF, dan seterusnya sengaja tidak ikut diperbarui; hanya data perangkat dari master.
    const written = (await tx.query<{ inserted: boolean }>(`INSERT INTO assets(eq,kind,serial_number,office_id,inventory_id)
      SELECT eq,'module',sn,office,inv FROM unnest($1::text[],$2::text[],$3::integer[],$4::integer[]) AS t(eq,sn,office,inv)
      ON CONFLICT(inventory_id) DO UPDATE SET eq=excluded.eq,serial_number=excluded.serial_number,office_id=excluded.office_id RETURNING (xmax=0) AS inserted`,
    [items.map(i => i.equipment_id), items.map(i => i.serial_number), items.map(i => officeIds.get(i.site_id)!), items.map(i => i.id)])).rows;
    for (const w of written) result.assets[w.inserted ? 'inserted' : 'updated']++;
    return result;
  };
  return dryRun ? run(db) : db.transaction(run);
}
