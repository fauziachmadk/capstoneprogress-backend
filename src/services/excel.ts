import ExcelJS from 'exceljs';
import { unzipSync } from 'fflate';
import { z } from 'zod';
import type { Database } from '../db.js';
import { ApiError } from '../errors.js';
export const MAX_IMPORT_ROWS = 5000;
const headers = ['EQ', 'Jenis', 'Serial Number', 'Kode Kantor', 'SN Chassis', 'REF', 'Status', 'Kondisi', 'Kode Aset'];
const rowSchema = z.object({
  eq: z.string().trim().min(1).max(255), kind: z.enum(['chassis', 'module']),
  serial_number: z.string().trim().min(1).max(255).transform(v => v.toUpperCase()),
  office_code: z.string().trim().min(1).max(255).transform(v => v.toUpperCase()),
  parent_sn: z.string().trim().max(255).transform(v => v.toUpperCase()).nullable(),
  ref: z.string().trim().max(255).nullable(), status: z.string().trim().max(255).nullable(),
  kondisi: z.string().trim().max(255).nullable(), asset_code: z.string().trim().max(255).nullable(),
}).refine(v => v.kind !== 'chassis' || !v.parent_sn, { message: 'Chassis tidak boleh memiliki SN Chassis.' });
type ImportRow = z.infer<typeof rowSchema> & { row: number; supplied_fields: string[] };
type RowError = { row: number; message: string };
export async function readExcel(buffer: Buffer): Promise<ImportRow[]> {
  if (buffer.length > 3 * 1024 * 1024) throw new ApiError(413, 'FILE_TOO_LARGE', 'File maksimal 3 MB.');
  try {
    let expanded = 0; let entries = 0;
    unzipSync(buffer, { filter: entry => {
      expanded += entry.originalSize; entries++;
      if (expanded > 32 * 1024 * 1024 || entries > 256) throw new Error('Ukuran arsip terlalu besar.');
      return false;
    } });
  } catch { throw new ApiError(422, 'INVALID_EXCEL', 'Arsip XLSX tidak valid atau terlalu besar.'); }
  const book = new ExcelJS.Workbook();
  try { await book.xlsx.load(buffer as any); }
  catch { throw new ApiError(422, 'INVALID_EXCEL', 'File harus berupa XLSX yang valid.'); }
  if (book.worksheets.length !== 1) throw new ApiError(422, 'INVALID_EXCEL', 'Gunakan tepat satu sheet.');
  const sheet = book.worksheets[0];
  if (sheet.rowCount > MAX_IMPORT_ROWS + 1 || sheet.columnCount > 9) throw new ApiError(422, 'IMPORT_LIMIT', `Maksimal ${MAX_IMPORT_ROWS} baris dan 9 kolom.`);
  const names: string[] = [];
  sheet.getRow(1).eachCell((cell, n) => { names[n - 1] = cell.text.trim(); });
  if (['EQ', 'Jenis', 'Serial Number', 'Kode Kantor'].some(h => !names.includes(h)) || names.some(h => !headers.includes(h)) || new Set(names).size !== names.length) {
    throw new ApiError(422, 'INVALID_HEADERS', 'Header Excel tidak sesuai.', { headers });
  }
  const rows: ImportRow[] = []; const errors: RowError[] = []; const seen = new Set<string>();
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    if (!row.hasValues) continue;
    let invalidCell = false;
    const value = (header: string): string | null => {
      const index = names.indexOf(header);
      if (index === -1) return null;
      const raw = row.getCell(index + 1).value;
      if (raw == null || raw === '') return null;
      if (typeof raw !== 'string' && typeof raw !== 'number') { invalidCell = true; return null; }
      return String(raw).trim() || null;
    };
    const kind = value('Jenis');
    const parsed = rowSchema.safeParse({ eq: value('EQ'), kind: kind === 'Chassis' ? 'chassis' : kind === 'Modul' ? 'module' : kind,
      serial_number: value('Serial Number'), office_code: value('Kode Kantor'), parent_sn: value('SN Chassis'),
      ref: value('REF'), status: value('Status'), kondisi: value('Kondisi'), asset_code: value('Kode Aset') });
    if (!parsed.success || invalidCell) {
      errors.push({ row: rowNumber, message: invalidCell ? 'Formula, tanggal, dan objek tidak diizinkan.' : parsed.error!.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
      continue;
    }
    if (seen.has(parsed.data.eq)) errors.push({ row: rowNumber, message: 'EQ duplikat dalam file.' });
    seen.add(parsed.data.eq);
    rows.push({ ...parsed.data, row: rowNumber, supplied_fields: names });
  }
  if (errors.length) throw new ApiError(422, 'IMPORT_VALIDATION', 'Periksa baris Excel.', errors);
  if (!rows.length) throw new ApiError(422, 'EMPTY_IMPORT', 'Tidak ada data aset.');
  return rows;
}
class DryRun extends Error { constructor(public result: unknown) { super('dry run'); } }
export async function importAssets(db: Database, buffer: Buffer, actorId: number, dryRun: boolean) {
  const rows = await readExcel(buffer);
  try {
    return await db.transaction(async tx => {
      // Serialize imports and asset edits so preview and commit use the same validation path.
      await tx.query('LOCK TABLE assets IN SHARE ROW EXCLUSIVE MODE');
      const offices = (await tx.query('SELECT id,code FROM offices')).rows;
      const officeMap = new Map(offices.map(o => [o.code, o.id]));
      const errors: RowError[] = rows.filter(r => !officeMap.has(r.office_code)).map(r => ({ row: r.row, message: 'Kode Kantor tidak ditemukan.' }));
      if (errors.length) throw new ApiError(422, 'IMPORT_VALIDATION', 'Periksa baris Excel.', errors);
      let created = 0; let updated = 0;
      const ordered = [...rows].sort((a, b) => (a.kind === 'chassis' ? 0 : 1) - (b.kind === 'chassis' ? 0 : 1));
      for (const row of ordered) {
        await tx.query('SAVEPOINT import_row');
        try {
          let parentId = null;
          if (row.parent_sn) {
            const parents = (await tx.query("SELECT id FROM assets WHERE kind='chassis' AND serial_number=$1 AND office_id=$2", [row.parent_sn, officeMap.get(row.office_code)])).rows;
            if (parents.length !== 1) throw new Error('SN Chassis harus cocok tepat satu chassis di kantor yang sama.');
            parentId = parents[0].id;
          }
          const existing = (await tx.query('SELECT id FROM assets WHERE eq=$1', [row.eq])).rows[0];
          const optionalColumns = [['SN Chassis', 'parent_id'], ['REF', 'ref'], ['Status', 'status'], ['Kondisi', 'kondisi'], ['Kode Aset', 'asset_code']];
          const optionalUpdates = optionalColumns.filter(([header]) => row.supplied_fields.includes(header)).map(([, column]) => `${column}=excluded.${column}`);
          await tx.query(`INSERT INTO assets(eq,kind,serial_number,office_id,parent_id,ref,status,kondisi,asset_code)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(eq) DO UPDATE SET
            kind=excluded.kind, serial_number=excluded.serial_number, office_id=excluded.office_id${optionalUpdates.length ? ',' + optionalUpdates.join(',') : ''}`,
          [row.eq, row.kind, row.serial_number, officeMap.get(row.office_code), parentId, row.ref ?? '', row.status ?? '', row.kondisi ?? '', row.asset_code ?? '']);
          if (existing) updated++; else created++;
          await tx.query('RELEASE SAVEPOINT import_row');
        } catch (error) {
          await tx.query('ROLLBACK TO SAVEPOINT import_row');
          errors.push({ row: row.row, message: error instanceof Error && !('code' in error) ? error.message : 'Relasi aset tidak valid; periksa chassis, kantor, dan modul terkait.' });
        }
      }
      if (errors.length) throw new ApiError(422, 'IMPORT_VALIDATION', 'Tidak ada perubahan disimpan. Periksa baris Excel.', errors);
      const result = { dry_run: dryRun, created, updated, total: rows.length };
      if (dryRun) throw new DryRun(result);
      return result;
    }, actorId);
  } catch (error) { if (error instanceof DryRun) return error.result; throw error; }
}
export async function exportExcel(rows: Record<string, any>[], columns: { header: string; key: string }[]) {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Data');
  sheet.columns = columns.map(c => ({ ...c, width: Math.max(18, c.header.length + 4) }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const row of rows) sheet.addRow(row);
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: columns.length } };
  return Buffer.from(await book.xlsx.writeBuffer());
}
export const assetExcelColumns = headers.map((header, index) => ({ header, key: ['eq', 'kind_label', 'serial_number', 'office_code', 'parent_sn', 'ref', 'status', 'kondisi', 'asset_code'][index] }));
