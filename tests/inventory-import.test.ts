import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { ConflictError, importInventory, parseCsv, parseInventory } from '../src/services/inventory-import.js';

const header = ['Territory', 'Regional Code', 'Regional Name', 'District Code', 'District Name', 'Sites Code', 'Sites Name', 'Functional Location',
  'Functional Location Description', 'Equipment ID', 'Equipment Name', '', 'Object Type', 'Inventory Number', 'NKA', 'NKA Acq. Date', 'Cost Center',
  'Manufacturer', 'Model / Type', 'Part Number', 'Serial Number', 'Maintenance Plant', 'Work Center', 'Superior Equipment', 'Remarks'];

type Over = Partial<Record<string, string>>;
// Satu baris dengan nilai bawaan; `over` memakai nama kolom (kategori = "Category").
function line(n: number, over: Over = {}) {
  const site = n % 2 ? { c: 'KLT', n: 'KLATEN' } : { c: 'SKH', n: 'SUKOHARJO' };
  const type = n % 3 ? { n: 'ROUTER - CISCO - ASR', cat: 'IP Core', o: 'ROUTER', m: 'Cisco', mo: 'ASR', p: 'ASR-20G' } : { n: 'SWITCH - HUAWEI - S5735', cat: 'Transmission', o: 'SWITCH', m: 'Huawei', mo: 'S5735', p: 'S5735-A' };
  const v: Record<string, string> = { Territory: 'TIF6', 'Regional Code': 'JATENGDIY', 'Regional Name': 'REGIONAL JATENG DIY', 'District Code': 'SURAKARTA', 'District Name': 'SURAKARTA',
    'Sites Code': site.c, 'Sites Name': site.n, 'Functional Location': `TIF6-1520-SURAKARTA-${site.c}`, 'Functional Location Description': `${site.n} - SURAKARTA`,
    'Equipment ID': `1000000${n}`, 'Equipment Name': type.n, Category: type.cat, 'Object Type': type.o, 'Inventory Number': `INV-${n}`, NKA: `NKA-${n}-0`, 'NKA Acq. Date': '2024-05-06',
    'Cost Center': 'TF6O2000', Manufacturer: type.m, 'Model / Type': type.mo, 'Part Number': type.p, 'Serial Number': `sn-${n}`, 'Maintenance Plant': '1520', 'Work Center': 'I050',
    'Superior Equipment': `2000${n}`, Remarks: `Data dummy ${n}`, ...over };
  return header.map(h => v[h === '' ? 'Category' : h]);
}
const csv = (rows: string[][]) => [header, ...rows].map(r => r.map(c => /[",\n]/.test(c) ? `"${c.replaceAll('"', '""')}"` : c).join(',')).join('\r\n') + '\r\n';
const six = () => [1, 2, 3, 4, 5, 6].map(n => line(n));

test('parseCsv: kutip, koma dan baris baru dalam kutip, BOM, CRLF, baris akhir tanpa newline', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x,1","y ""q""\nz"\r\n,\r\nlast'), [['a', 'b'], ['x,1', 'y "q"\nz'], ['', ''], ['last']]);
  assert.deepEqual(parseCsv(''), []);
  assert.throws(() => parseCsv('a,"b'), /kutip/);
});

test('parseInventory menerima data valid dan menormalkan SN serta kode site', () => {
  const { rows, errors } = parseInventory(csv(six()));
  assert.deepEqual(errors, []); assert.equal(rows.length, 6);
  assert.equal(rows[0].serialNumber, 'SN-1'); assert.equal(rows[0].siteCode, 'KLT'); assert.equal(rows[0].category, 'IP Core'); assert.equal(rows[0].line, 2);
  const empty = parseInventory(csv([line(1, { 'NKA Acq. Date': '' })]));
  assert.equal(empty.rows[0].nkaAcqDate, null);
});

test('parseInventory melaporkan semua masalah dengan nomor baris', () => {
  const missing = parseInventory(csv(six()).replace('Serial Number', 'SN'));
  assert.match(missing.errors[0].message, /Serial Number/); assert.equal(missing.errors[0].line, 1);
  const noCategory = [header.filter(h => h !== ''), ...six().map(r => r.filter((_, i) => i !== 11))].map(r => r.join(',')).join('\n');
  assert.match(parseInventory(noCategory).errors[0].message, /kategori/);

  const bad = parseInventory(csv([
    line(1), line(2, { 'Equipment ID': '10000001' }), line(3, { NKA: 'NKA-1-0' }), line(4, { 'Inventory Number': 'INV-1' }),
    line(5, { 'NKA Acq. Date': '2024-02-30' }), line(7, { 'Serial Number': '' }), line(9, { 'Sites Name': 'BEDA' }),
    line(11, { 'Functional Location': 'TIF6-1520-SURAKARTA-SKH' }), line(13, { Manufacturer: 'Lain' }),
  ]));
  const text = bad.errors.map(e => `${e.line}:${e.message}`).join('\n');
  for (const part of ['3:Equipment ID "10000001" duplikat dengan baris 2', '4:NKA "NKA-1-0" duplikat dengan baris 2', '5:Inventory Number "INV-1" duplikat dengan baris 2',
    '6:NKA Acq. Date "2024-02-30"', '7:Serial Number wajib diisi', '8:Data site KLT berbeda dengan baris 2', '9:Functional Location', '10:Data jenis']) {
    assert.ok(text.includes(part), `${part}\n---\n${text}`);
  }
  assert.equal(parseInventory(csv(six()).replace(/\r\n$/, '\r\nx,y\r\n')).errors[0].message, 'Jumlah kolom 2, seharusnya 25.');
  assert.equal(parseInventory(header.join(',') + '\n').errors[0].message, 'Tidak ada baris data.');
});

test('impor: dry-run tidak menulis, commit menyimpan, ulang menjadi update, perubahan ikut', async t => {
  const f = await fixture(); t.after(() => f.close());
  const { rows } = parseInventory(csv(six()));
  const n = async (table: string) => Number((await f.db.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);

  assert.deepEqual(await importInventory(f.db, rows, true), { dryRun: true, types: { inserted: 2, updated: 0 }, sites: { inserted: 2, updated: 0 }, items: { inserted: 6, updated: 0 } });
  assert.deepEqual([await n('equipment_types'), await n('inventory_sites'), await n('asset_inventory')], [0, 0, 0]);

  assert.deepEqual(await importInventory(f.db, rows, false), { dryRun: false, types: { inserted: 2, updated: 0 }, sites: { inserted: 2, updated: 0 }, items: { inserted: 6, updated: 0 } });
  assert.deepEqual([await n('equipment_types'), await n('inventory_sites'), await n('asset_inventory')], [2, 2, 6]);
  const joined = (await f.db.query(`SELECT i.equipment_id,i.serial_number,i.nka_acq_date::text AS d,t.name AS type,t.category,s.code,s.functional_location,s.cost_center
    FROM asset_inventory i JOIN equipment_types t ON t.id=i.type_id JOIN inventory_sites s ON s.id=i.site_id WHERE i.equipment_id='10000001'`)).rows[0];
  assert.deepEqual({ ...joined }, { equipment_id: '10000001', serial_number: 'SN-1', d: '2024-05-06', type: 'ROUTER - CISCO - ASR', category: 'IP Core', code: 'KLT', functional_location: 'TIF6-1520-SURAKARTA-KLT', cost_center: 'TF6O2000' });

  // Ulangi: tidak ada baris baru, semuanya update; ID stabil.
  const before = (await f.db.query('SELECT max(id) AS m FROM asset_inventory')).rows[0].m;
  assert.deepEqual(await importInventory(f.db, rows, true), { dryRun: true, types: { inserted: 0, updated: 2 }, sites: { inserted: 0, updated: 2 }, items: { inserted: 0, updated: 6 } });
  assert.deepEqual(await importInventory(f.db, rows, false), { dryRun: false, types: { inserted: 0, updated: 2 }, sites: { inserted: 0, updated: 2 }, items: { inserted: 0, updated: 6 } });
  assert.equal((await f.db.query('SELECT max(id) AS m FROM asset_inventory')).rows[0].m, before);

  // Perubahan nilai dan baris baru: yang lama diperbarui, yang baru ditambah.
  const changed = parseInventory(csv([line(1, { Remarks: 'diubah', 'Serial Number': 'x-9' }), line(7)])).rows;
  assert.deepEqual((await importInventory(f.db, changed, false)).items, { inserted: 1, updated: 1 });
  assert.deepEqual((await f.db.query("SELECT serial_number,remarks FROM asset_inventory WHERE equipment_id='10000001'")).rows[0], { serial_number: 'X-9', remarks: 'diubah' });
  assert.equal(await n('asset_inventory'), 7);
});

test('impor: tabrakan dengan data di database dilaporkan dan tidak ada yang tersimpan', async t => {
  const f = await fixture(); t.after(() => f.close());
  await importInventory(f.db, parseInventory(csv(six())).rows, false);
  const clash = parseInventory(csv([line(8, { 'Inventory Number': 'INV-1' }), line(9, { NKA: 'NKA-2-0' }), line(10, { 'Equipment ID': '10000011' })])).rows;
  for (const dryRun of [true, false]) {
    await assert.rejects(importInventory(f.db, clash, dryRun), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.deepEqual(error.issues.map(i => i.message.split(' sudah')[0]), ['Inventory Number "INV-1"', 'NKA "NKA-2-0"']);
      return true;
    });
  }
  assert.equal((await f.db.query('SELECT count(*) AS n FROM asset_inventory')).rows[0].n, 6);

  const location = parseInventory(csv([line(1, { 'Sites Code': 'BARU', 'Equipment ID': '10000099', 'Inventory Number': 'INV-99', NKA: 'N-99' })])).rows;
  await assert.rejects(importInventory(f.db, location, false), /Tabrakan/);
  assert.equal((await f.db.query("SELECT count(*) AS n FROM inventory_sites WHERE code='BARU'")).rows[0].n, 0);
});
