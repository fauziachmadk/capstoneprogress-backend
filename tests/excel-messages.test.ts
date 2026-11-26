import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, excel } from './helpers.js';
import { importAssets } from '../src/services/excel.js';

test('pesan baris Excel yang bermasalah memakai nama kolom dan bahasa Indonesia', async t => {
  const f = await fixture(); t.after(() => f.close());
  // Kolom: EQ, Jenis, Serial Number, Kode Kantor, SN Chassis.
  const file = await excel([
    [null, 'Chassis', 'SN-A', 'KTR-GRB'],
    ['EQ-B', 'Router', 'SN-B', 'KTR-GRB'],
    ['EQ-C', 'Chassis', null, 'KTR-GRB'],
    ['EQ-D', 'Chassis', 'SN-D', null],
    ['EQ-E', 'Chassis', 'SN-E', 'KTR-GRB', 'SN-INDUK'],
    ['E'.repeat(256), 'Chassis', 'SN-F', 'KTR-GRB'],
  ]);
  await assert.rejects(importAssets(f.db, file, f.admin, true), (e: any) => {
    assert.equal(e.code, 'IMPORT_VALIDATION');
    const byRow = Object.fromEntries(e.details.map((d: any) => [d.row, d.message]));
    assert.equal(byRow[2], 'EQ wajib diisi.');
    assert.equal(byRow[3], 'Jenis harus Chassis atau Modul.');
    assert.equal(byRow[4], 'Serial Number wajib diisi.');
    assert.equal(byRow[5], 'Kode Kantor wajib diisi.');
    assert.equal(byRow[6], 'Chassis tidak boleh memiliki SN Chassis.');
    assert.equal(byRow[7], 'EQ terlalu panjang (maksimal 255 karakter).');
    assert.ok(e.details.every((d: any) => !/expected|received|Invalid input/.test(d.message)));
    return true;
  });
});
