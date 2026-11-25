import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { fixture, multipartFile } from './helpers.js';

const exported = ['EQ', 'Jenis', 'Serial Number', 'Kode Kantor', 'SN Chassis', 'REF', 'Status', 'Kondisi', 'Kode Aset', 'Label', 'Kode Label'];
const importFile = (headers: object, buffer: Buffer, query = 'dry_run=true') => ({ url: `/api/assets/import?${query}`, headers: { ...headers, ...multipartFile(buffer).headers }, payload: multipartFile(buffer).payload });

async function exportFile(f: Awaited<ReturnType<typeof fixture>>, admin: object) {
  const res = await f.app.inject({ url: '/api/assets/export', headers: admin as any });
  assert.equal(res.statusCode, 200);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(res.rawPayload as any);
  return { buffer: Buffer.from(res.rawPayload), sheet: book.worksheets[0] };
}

test('ekspor memuat 11 kolom termasuk Label dan Kode Label, sama dengan frontend', async t => {
  const f = await fixture(); t.after(() => f.close());
  const admin = await f.login();
  await f.db.query("INSERT INTO assets(eq,kind,serial_number,office_id,parent_id,label_status,label_code) VALUES('EQ-MOD','module','SN-MOD',$1,$2,'terpasang','LBL-77')", [f.office, f.asset]);
  const { sheet } = await exportFile(f, admin);
  assert.deepEqual((sheet.getRow(1).values as string[]).slice(1), exported);
  const rows = new Map<string, any>(); sheet.eachRow((row, n) => { if (n > 1) rows.set(String(row.getCell(1).value), row); });
  const chassis = rows.get('EQ-001'); const module = rows.get('EQ-MOD');
  assert.equal(chassis.getCell(2).value, 'Chassis'); assert.equal(chassis.getCell(10).value, 'belum'); assert.ok(!chassis.getCell(11).value);
  assert.equal(module.getCell(2).value, 'Modul'); assert.equal(module.getCell(5).value, 'SN-001'); assert.equal(module.getCell(10).value, 'terpasang'); assert.equal(module.getCell(11).value, 'LBL-77');
});

test('file hasil ekspor (11 kolom) dapat diimpor ulang; Label dan Kode Label diabaikan', async t => {
  const f = await fixture(); t.after(() => f.close());
  const admin = await f.login();
  await f.db.query("INSERT INTO assets(eq,kind,serial_number,office_id,parent_id,label_status,label_code) VALUES('EQ-MOD','module','SN-MOD',$1,$2,'terpasang','LBL-77')", [f.office, f.asset]);
  const { buffer, sheet } = await exportFile(f, admin);
  assert.equal(sheet.columnCount, 11);

  const dry = await f.app.inject({ method: 'POST', ...importFile(admin, buffer) });
  assert.equal(dry.statusCode, 200, dry.body);
  assert.equal(dry.json().data.dry_run, true); assert.deepEqual([dry.json().data.created, dry.json().data.updated], [0, 3]);

  // Mengubah Label/Kode Label di file tidak mengubah label aset di database.
  const book = new ExcelJS.Workbook(); await book.xlsx.load(buffer as any);
  const sheetEdit = book.worksheets[0]; sheetEdit.eachRow((row, n) => { if (n > 1) { row.getCell(10).value = 'terpasang'; row.getCell(11).value = 'DIUBAH'; } });
  const edited = Buffer.from(await book.xlsx.writeBuffer());
  const saved = await f.app.inject({ method: 'POST', ...importFile(admin, edited, 'dry_run=false') });
  assert.equal(saved.statusCode, 201, saved.body);
  const labels = (await f.db.query("SELECT eq,label_status,label_code FROM assets WHERE eq IN ('EQ-001','EQ-MOD') ORDER BY eq")).rows;
  assert.deepEqual(labels.map(r => [r.eq, r.label_status, r.label_code]), [['EQ-001', 'belum', null], ['EQ-MOD', 'terpasang', 'LBL-77']]);
});

test('batas kolom 11 dan header yang tidak dikenal tetap ditolak', async t => {
  const f = await fixture(); t.after(() => f.close());
  const admin = await f.login();
  const header = (extra: string[]) => [...exported.slice(0, 4), ...extra];
  const build = async (names: string[]) => { const book = new ExcelJS.Workbook(); const s = book.addWorksheet('Aset'); s.addRow(names); s.addRow(['EQ-X', 'Chassis', 'SN-X', 'KTR-GRB']); return Buffer.from(await book.xlsx.writeBuffer()); };

  assert.equal((await f.app.inject({ method: 'POST', ...importFile(admin, await build(exported)) })).statusCode, 200);
  assert.equal((await f.app.inject({ method: 'POST', ...importFile(admin, await build(header(['Label']))) })).statusCode, 200);
  const twelve = await f.app.inject({ method: 'POST', ...importFile(admin, await build([...exported, 'Catatan'])) });
  assert.equal(twelve.statusCode, 422); assert.equal(twelve.json().error.code, 'IMPORT_LIMIT'); assert.match(twelve.json().error.message, /11 kolom/);
  const unknown = await f.app.inject({ method: 'POST', ...importFile(admin, await build(header(['Catatan']))) });
  assert.equal(unknown.statusCode, 422); assert.equal(unknown.json().error.code, 'INVALID_HEADERS'); assert.deepEqual(unknown.json().error.details.headers, exported);
  const duplicate = await f.app.inject({ method: 'POST', ...importFile(admin, await build([...exported.slice(0, 9), 'Label', 'Label'])) });
  assert.equal(duplicate.statusCode, 422); assert.equal(duplicate.json().error.code, 'INVALID_HEADERS');
});
