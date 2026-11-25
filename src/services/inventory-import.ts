import type { Database } from '../db.js';

// Impor master inventaris dari CSV (gaya ekspor SAP PM) ke equipment_types, inventory_sites, dan asset_inventory.
// Kunci upsert: Equipment Name (jenis), Sites Code (site), dan Equipment ID (aset). Aman dijalankan ulang.

export interface InventoryRow {
  line: number;
  territory: string; regionalCode: string; regionalName: string; districtCode: string; districtName: string;
  siteCode: string; siteName: string; functionalLocation: string; siteDescription: string;
  equipmentId: string; equipmentName: string; category: string; objectType: string;
  inventoryNumber: string; nka: string; nkaAcqDate: string | null;
  costCenter: string; manufacturer: string; model: string; partNumber: string; serialNumber: string;
  maintenancePlant: string; workCenter: string; superiorEquipment: string; remarks: string;
}
export interface Issue { line: number; message: string }
export interface InventoryImportResult {
  dryRun: boolean;
  types: { inserted: number; updated: number };
  sites: { inserted: number; updated: number };
  items: { inserted: number; updated: number };
}

const requiredHeaders = ['Territory', 'Regional Code', 'Regional Name', 'District Code', 'District Name', 'Sites Code', 'Sites Name',
  'Functional Location', 'Functional Location Description', 'Equipment ID', 'Equipment Name', 'Object Type', 'Inventory Number', 'NKA',
  'NKA Acq. Date', 'Cost Center', 'Manufacturer', 'Model / Type', 'Part Number', 'Serial Number', 'Maintenance Plant', 'Work Center',
  'Superior Equipment', 'Remarks'];
const mustHave = ['Sites Code', 'Sites Name', 'Functional Location', 'Equipment ID', 'Equipment Name', 'Inventory Number', 'NKA', 'Serial Number'];

/** CSV sesuai RFC 4180: tanda kutip ganda, koma dan baris baru di dalam kutip, BOM, CRLF. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false; let touched = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch;
    } else if (ch === '"') { quoted = true; touched = true; }
    else if (ch === ',') { row.push(cell); cell = ''; touched = true; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (touched || cell !== '') { row.push(cell); rows.push(row); }
      row = []; cell = ''; touched = false;
    } else { cell += ch; touched = true; }
  }
  if (quoted) throw new Error('CSV tidak valid: tanda kutip tidak ditutup.');
  if (touched || cell !== '') { row.push(cell); rows.push(row); }
  return rows;
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function parseInventory(text: string): { rows: InventoryRow[]; errors: Issue[] } {
  const table = parseCsv(text);
  const errors: Issue[] = [];
  if (!table.length) return { rows: [], errors: [{ line: 1, message: 'File kosong.' }] };
  const headers = table[0].map(h => h.trim());
  const index = new Map<string, number>();
  headers.forEach((h, i) => { if (h && !index.has(h)) index.set(h, i); });
  const missing = requiredHeaders.filter(h => !index.has(h));
  // Kolom kategori (Access, Transmission, ...) tidak punya judul di sumber; dikenali dari judul kosong atau "Category".
  const categoryColumns = headers.flatMap((h, i) => h === '' || h.toLowerCase() === 'category' ? [i] : []);
  if (missing.length) errors.push({ line: 1, message: `Kolom wajib tidak ditemukan: ${missing.join(', ')}.` });
  if (categoryColumns.length !== 1) errors.push({ line: 1, message: 'Harus ada tepat satu kolom kategori (judul kosong atau "Category").' });
  if (errors.length) return { rows: [], errors };

  const rows: InventoryRow[] = [];
  const first = { equipment: new Map<string, number>(), inventory: new Map<string, number>(), nka: new Map<string, number>() };
  const sites = new Map<string, InventoryRow>(); const locations = new Map<string, string>(); const types = new Map<string, InventoryRow>();
  for (let n = 1; n < table.length; n++) {
    const line = n + 1; const cells = table[n];
    if (cells.every(c => c.trim() === '')) continue;
    if (cells.length !== headers.length) { errors.push({ line, message: `Jumlah kolom ${cells.length}, seharusnya ${headers.length}.` }); continue; }
    const get = (name: string) => cells[index.get(name)!].trim();
    const date = get('NKA Acq. Date');
    const row: InventoryRow = {
      line, territory: get('Territory'), regionalCode: get('Regional Code'), regionalName: get('Regional Name'),
      districtCode: get('District Code'), districtName: get('District Name'), siteCode: get('Sites Code').toUpperCase(),
      siteName: get('Sites Name'), functionalLocation: get('Functional Location'), siteDescription: get('Functional Location Description'),
      equipmentId: get('Equipment ID'), equipmentName: get('Equipment Name'), category: cells[categoryColumns[0]].trim(),
      objectType: get('Object Type'), inventoryNumber: get('Inventory Number'), nka: get('NKA'), nkaAcqDate: date || null,
      costCenter: get('Cost Center'), manufacturer: get('Manufacturer'), model: get('Model / Type'), partNumber: get('Part Number'),
      serialNumber: get('Serial Number').toUpperCase(), maintenancePlant: get('Maintenance Plant'), workCenter: get('Work Center'),
      superiorEquipment: get('Superior Equipment'), remarks: get('Remarks'),
    };
    const problems: string[] = [];
    for (const name of mustHave) if (!get(name)) problems.push(`${name} wajib diisi`);
    if (date && !validDate(date)) problems.push(`NKA Acq. Date "${date}" bukan tanggal YYYY-MM-DD yang valid`);
    for (const [map, key, label] of [[first.equipment, row.equipmentId, 'Equipment ID'], [first.inventory, row.inventoryNumber, 'Inventory Number'], [first.nka, row.nka, 'NKA']] as const) {
      if (!key) continue;
      const seen = map.get(key);
      if (seen) problems.push(`${label} "${key}" duplikat dengan baris ${seen}`); else map.set(key, line);
    }
    const site = sites.get(row.siteCode);
    if (!site) sites.set(row.siteCode, row);
    else if (['siteName', 'functionalLocation', 'siteDescription', 'territory', 'regionalCode', 'regionalName', 'districtCode', 'districtName', 'costCenter', 'maintenancePlant', 'workCenter']
      .some(k => site[k as keyof InventoryRow] !== row[k as keyof InventoryRow])) problems.push(`Data site ${row.siteCode} berbeda dengan baris ${site.line}`);
    const owner = locations.get(row.functionalLocation);
    if (owner && owner !== row.siteCode) problems.push(`Functional Location "${row.functionalLocation}" dipakai site ${owner} dan ${row.siteCode}`);
    else if (row.functionalLocation) locations.set(row.functionalLocation, row.siteCode);
    const type = types.get(row.equipmentName);
    if (!type) types.set(row.equipmentName, row);
    else if (['category', 'objectType', 'manufacturer', 'model', 'partNumber'].some(k => type[k as keyof InventoryRow] !== row[k as keyof InventoryRow])) {
      problems.push(`Data jenis "${row.equipmentName}" berbeda dengan baris ${type.line}`);
    }
    if (problems.length) problems.forEach(message => errors.push({ line, message })); else rows.push(row);
  }
  if (!errors.length && !rows.length) errors.push({ line: 1, message: 'Tidak ada baris data.' });
  return { rows, errors };
}

// Tabrakan dengan data yang sudah ada di database: nomor inventaris/NKA milik aset lain, atau Functional Location milik site lain.
async function findConflicts(db: Database, rows: InventoryRow[]): Promise<Issue[]> {
  const issues: Issue[] = [];
  const byInventory = new Map(rows.map(r => [r.inventoryNumber, r])); const byNka = new Map(rows.map(r => [r.nka, r]));
  const existing = (await db.query<{ equipment_id: string; inventory_number: string; nka: string }>(
    'SELECT equipment_id,inventory_number,nka FROM asset_inventory WHERE inventory_number=ANY($1::text[]) OR nka=ANY($2::text[])',
    [rows.map(r => r.inventoryNumber), rows.map(r => r.nka)])).rows;
  for (const e of existing) {
    const a = byInventory.get(e.inventory_number); const b = byNka.get(e.nka);
    if (a && a.equipmentId !== e.equipment_id) issues.push({ line: a.line, message: `Inventory Number "${a.inventoryNumber}" sudah dipakai Equipment ID ${e.equipment_id} di database` });
    if (b && b.equipmentId !== e.equipment_id) issues.push({ line: b.line, message: `NKA "${b.nka}" sudah dipakai Equipment ID ${e.equipment_id} di database` });
  }
  const sites = new Map(rows.map(r => [r.functionalLocation, r]));
  for (const s of (await db.query<{ code: string; functional_location: string }>(
    'SELECT code,functional_location FROM inventory_sites WHERE functional_location=ANY($1::text[])', [[...sites.keys()]])).rows) {
    const r = sites.get(s.functional_location)!;
    if (r.siteCode !== s.code) issues.push({ line: r.line, message: `Functional Location "${r.functionalLocation}" sudah dipakai site ${s.code} di database` });
  }
  return issues;
}

const unique = <T>(values: T[]) => [...new Set(values)];

export async function importInventory(db: Database, rows: InventoryRow[], dryRun: boolean): Promise<InventoryImportResult> {
  const types = [...new Map(rows.map(r => [r.equipmentName, r])).values()];
  const sites = [...new Map(rows.map(r => [r.siteCode, r])).values()];
  if (dryRun) {
    // Tanpa penulisan sama sekali (urutan ID tidak terbuang): hitung dari kunci yang sudah ada.
    const conflicts = await findConflicts(db, rows);
    if (conflicts.length) throw new ConflictError(conflicts);
    const count = async (sql: string, keys: string[]) => Number((await db.query<{ n: number }>(sql, [keys])).rows[0].n);
    const t = await count('SELECT count(*)::int AS n FROM equipment_types WHERE name=ANY($1::text[])', types.map(x => x.equipmentName));
    const s = await count('SELECT count(*)::int AS n FROM inventory_sites WHERE code=ANY($1::text[])', sites.map(x => x.siteCode));
    const i = await count('SELECT count(*)::int AS n FROM asset_inventory WHERE equipment_id=ANY($1::text[])', rows.map(x => x.equipmentId));
    return { dryRun, types: { inserted: types.length - t, updated: t }, sites: { inserted: sites.length - s, updated: s }, items: { inserted: rows.length - i, updated: i } };
  }
  return db.transaction(async tx => {
    const conflicts = await findConflicts(tx, rows);
    if (conflicts.length) throw new ConflictError(conflicts);
    const tally = { types: { inserted: 0, updated: 0 }, sites: { inserted: 0, updated: 0 }, items: { inserted: 0, updated: 0 } };
    const typeIds = new Map<string, number>(); const siteIds = new Map<string, number>();
    for (const t of types) {
      const r = (await tx.query<{ id: number; inserted: boolean }>(`INSERT INTO equipment_types(name,category,object_type,manufacturer,model,part_number)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(name) DO UPDATE SET category=excluded.category,object_type=excluded.object_type,
        manufacturer=excluded.manufacturer,model=excluded.model,part_number=excluded.part_number RETURNING id,(xmax=0) AS inserted`,
      [t.equipmentName, t.category, t.objectType, t.manufacturer, t.model, t.partNumber])).rows[0];
      typeIds.set(t.equipmentName, r.id); tally.types[r.inserted ? 'inserted' : 'updated']++;
    }
    for (const s of sites) {
      const r = (await tx.query<{ id: number; inserted: boolean }>(`INSERT INTO inventory_sites(code,name,functional_location,description,territory,regional_code,
        regional_name,district_code,district_name,cost_center,maintenance_plant,work_center) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT(code) DO UPDATE SET name=excluded.name,functional_location=excluded.functional_location,description=excluded.description,
        territory=excluded.territory,regional_code=excluded.regional_code,regional_name=excluded.regional_name,district_code=excluded.district_code,
        district_name=excluded.district_name,cost_center=excluded.cost_center,maintenance_plant=excluded.maintenance_plant,work_center=excluded.work_center
        RETURNING id,(xmax=0) AS inserted`,
      [s.siteCode, s.siteName, s.functionalLocation, s.siteDescription, s.territory, s.regionalCode, s.regionalName, s.districtCode, s.districtName,
        s.costCenter, s.maintenancePlant, s.workCenter])).rows[0];
      siteIds.set(s.siteCode, r.id); tally.sites[r.inserted ? 'inserted' : 'updated']++;
    }
    const written = (await tx.query<{ inserted: boolean }>(`INSERT INTO asset_inventory(equipment_id,inventory_number,nka,nka_acq_date,serial_number,
      superior_equipment,remarks,type_id,site_id)
      SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$4::date[],$5::text[],$6::text[],$7::text[],$8::integer[],$9::integer[])
      ON CONFLICT(equipment_id) DO UPDATE SET inventory_number=excluded.inventory_number,nka=excluded.nka,nka_acq_date=excluded.nka_acq_date,
        serial_number=excluded.serial_number,superior_equipment=excluded.superior_equipment,remarks=excluded.remarks,type_id=excluded.type_id,
        site_id=excluded.site_id RETURNING (xmax=0) AS inserted`,
    [rows.map(r => r.equipmentId), rows.map(r => r.inventoryNumber), rows.map(r => r.nka), rows.map(r => r.nkaAcqDate), rows.map(r => r.serialNumber),
      rows.map(r => r.superiorEquipment), rows.map(r => r.remarks), rows.map(r => typeIds.get(r.equipmentName)!), rows.map(r => siteIds.get(r.siteCode)!)])).rows;
    for (const w of written) tally.items[w.inserted ? 'inserted' : 'updated']++;
    return { dryRun, ...tally };
  });
}

export class ConflictError extends Error {
  constructor(public issues: Issue[]) { super(`Tabrakan dengan data di database (${unique(issues.map(i => i.line)).length} baris).`); }
}
