import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { SyncConflictError, syncInventory } from '../src/services/inventory-sync.js';

// Master kecil langsung lewat SQL: 2 site, 1 jenis, 4 aset.
async function seedMaster(db: any) {
  await db.query("INSERT INTO equipment_types(name) VALUES('ROUTER')");
  await db.query("INSERT INTO inventory_sites(code,name,functional_location,description) VALUES('KLT','KLATEN','FL-KLT','KLATEN - SURAKARTA'),('SKH','SUKOHARJO','FL-SKH','SUKOHARJO - SURAKARTA')");
  await db.query(`INSERT INTO asset_inventory(equipment_id,inventory_number,nka,serial_number,type_id,site_id)
    SELECT 'EQ-'||n,'INV-'||n,'NKA-'||n,'SN-'||n,(SELECT id FROM equipment_types LIMIT 1),(SELECT id FROM inventory_sites WHERE code=CASE WHEN n<=2 THEN 'KLT' ELSE 'SKH' END)
    FROM generate_series(1,4) n`);
}

test('sinkron membuat satu kantor per site dan satu aset kerja per baris master', async t => {
  const f = await fixture(); t.after(() => f.close());
  await seedMaster(f.db);
  const dry = await syncInventory(f.db, true);
  assert.deepEqual(dry, { dryRun: true, offices: { inserted: 2, updated: 0 }, assets: { inserted: 4, updated: 0 } });
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM offices WHERE site_id IS NOT NULL")).rows[0].n, 0);

  const done = await syncInventory(f.db, false);
  assert.deepEqual(done, { dryRun: false, offices: { inserted: 2, updated: 0 }, assets: { inserted: 4, updated: 0 } });
  const offices = (await f.db.query("SELECT code,name,address,area FROM offices WHERE site_id IS NOT NULL ORDER BY code")).rows;
  assert.deepEqual(offices, [{ code: 'KLT', name: 'KLATEN', address: 'KLATEN - SURAKARTA', area: 'solo' }, { code: 'SKH', name: 'SUKOHARJO', address: 'SUKOHARJO - SURAKARTA', area: 'solo' }]);
  const a = (await f.db.query(`SELECT a.eq,a.kind,a.serial_number,a.parent_id,a.mapping_status,a.label_status,o.code AS office FROM assets a JOIN offices o ON o.id=a.office_id
    WHERE a.inventory_id IS NOT NULL ORDER BY a.eq`)).rows;
  assert.equal(a.length, 4);
  assert.deepEqual(a[0], { eq: 'EQ-1', kind: 'module', serial_number: 'SN-1', parent_id: null, mapping_status: 'belum', label_status: 'belum', office: 'KLT' });
  assert.equal(a[3].office, 'SKH');
});

test('sinkron aman diulang dan tidak menimpa status kerja', async t => {
  const f = await fixture(); t.after(() => f.close());
  await seedMaster(f.db);
  await syncInventory(f.db, false);
  // Perubahan REF wajib punya actor (trigger riwayat), jadi lewat transaksi dengan pelaku.
  await f.db.transaction(tx => tx.query("UPDATE assets SET mapping_status='sudah', label_status='terpasang', ref='REF-X' WHERE eq='EQ-2'"), f.admin);
  await f.db.query("UPDATE asset_inventory SET serial_number='SN-NEW' WHERE equipment_id='EQ-2'");
  const again = await syncInventory(f.db, false);
  assert.deepEqual(again, { dryRun: false, offices: { inserted: 0, updated: 2 }, assets: { inserted: 0, updated: 4 } });
  const row = (await f.db.query("SELECT mapping_status,label_status,ref,serial_number FROM assets WHERE eq='EQ-2'")).rows[0];
  assert.deepEqual(row, { mapping_status: 'sudah', label_status: 'terpasang', ref: 'REF-X', serial_number: 'SN-NEW' });
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM assets WHERE inventory_id IS NOT NULL")).rows[0].n, 4);
});

test('sinkron menolak kode kantor atau EQ yang sudah dipakai data non-master dan tidak menulis apa pun', async t => {
  const f = await fixture(); t.after(() => f.close());
  await seedMaster(f.db);
  const before = (await f.db.query('SELECT count(*)::int AS n FROM offices')).rows[0].n;
  await f.db.query("INSERT INTO offices(code,name,address,area) VALUES('KLT','Bukan master','','solo')");
  await assert.rejects(syncInventory(f.db, false), (e: any) => e instanceof SyncConflictError && /KLT/.test(e.issues[0].message));
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM offices')).rows[0].n, before + 1);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM assets WHERE inventory_id IS NOT NULL')).rows[0].n, 0);
  await f.db.query("DELETE FROM offices WHERE code='KLT'");
  const office = (await f.db.query("INSERT INTO offices(code,name,address,area) VALUES('LAIN','Lain','','solo') RETURNING id")).rows[0].id;
  await f.db.query("INSERT INTO assets(eq,kind,serial_number,office_id) VALUES('EQ-3','module','X',$1)", [office]);
  await assert.rejects(syncInventory(f.db, true), (e: any) => e instanceof SyncConflictError && /EQ-3/.test(e.issues[0].message));
});
