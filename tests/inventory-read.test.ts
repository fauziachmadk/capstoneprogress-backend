import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { importInventory, type InventoryRow } from '../src/services/inventory-import.js';

// 6 aset: 2 site (KLT ganjil, SKH genap) x 2 jenis (ROUTER bila n%3<>0, SWITCH bila n%3=0).
function row(n: number): InventoryRow {
  const site = n % 2 ? { c: 'KLT', n: 'KLATEN' } : { c: 'SKH', n: 'SUKOHARJO' };
  const router = n % 3 !== 0;
  return { line: n + 1, territory: 'TIF6', regionalCode: 'JATENGDIY', regionalName: 'REGIONAL JATENG DIY', districtCode: 'SURAKARTA', districtName: 'SURAKARTA',
    siteCode: site.c, siteName: site.n, functionalLocation: `TIF6-1520-SURAKARTA-${site.c}`, siteDescription: `${site.n} - SURAKARTA`,
    equipmentId: `1000000${n}`, equipmentName: router ? 'ROUTER - CISCO - ASR' : 'SWITCH - HUAWEI - S5735', category: router ? 'IP Core' : 'Transmission',
    objectType: router ? 'ROUTER' : 'SWITCH', inventoryNumber: `INV-${n}`, nka: `NKA-${n}-0`, nkaAcqDate: `2024-0${n}-10`, costCenter: 'TF6O2000',
    manufacturer: router ? 'Cisco' : 'Huawei', model: router ? 'ASR' : 'S5735', partNumber: router ? 'ASR-20G' : 'S5735-A', serialNumber: `SN-${n}`,
    maintenancePlant: '1520', workCenter: 'I050', superiorEquipment: `2000${n}`, remarks: `Data dummy ${n}` };
}

test('endpoint inventaris: daftar jenis, site, dan aset dengan jumlah, bentuk, serta urutan', async t => {
  const f = await fixture(); t.after(() => f.close());
  const admin = await f.login();
  const get = async (path: string) => { const res = await f.app.inject({ url: path, headers: admin }); assert.equal(res.statusCode, 200, `${path} ${res.body}`); return res.json(); };

  // Kosong sebelum impor.
  assert.deepEqual((await get('/api/inventory')).meta, { page: 1, limit: 25, total: 0 });
  await importInventory(f.db, [1, 2, 3, 4, 5, 6].map(row), false);

  const types = await get('/api/equipment-types');
  assert.deepEqual(types.data.map((x: any) => [x.name, x.category, x.items]), [['ROUTER - CISCO - ASR', 'IP Core', 4], ['SWITCH - HUAWEI - S5735', 'Transmission', 2]]);
  assert.deepEqual(Object.keys(types.data[0]).sort(), ['category', 'id', 'items', 'manufacturer', 'model', 'name', 'object_type', 'part_number']);
  assert.deepEqual((await get('/api/equipment-types?search=huawei')).data.map((x: any) => x.name), ['SWITCH - HUAWEI - S5735']);

  const sites = await get('/api/inventory-sites');
  assert.deepEqual(sites.data.map((x: any) => [x.code, x.name, x.items]), [['KLT', 'KLATEN', 3], ['SKH', 'SUKOHARJO', 3]]);
  assert.equal(sites.data[0].functional_location, 'TIF6-1520-SURAKARTA-KLT'); assert.equal(sites.data[0].cost_center, 'TF6O2000');
  assert.deepEqual((await get('/api/inventory-sites?search=sukoh')).data.map((x: any) => x.code), ['SKH']);
  assert.equal((await get('/api/inventory-sites?search=%25')).meta.total, 0);

  const all = await get('/api/inventory');
  assert.equal(all.meta.total, 6);
  assert.deepEqual(all.data.map((x: any) => x.equipment_id), ['10000001', '10000005', '10000003', '10000002', '10000004', '10000006']);
  assert.deepEqual({ ...all.data[0] }, { id: all.data[0].id, equipment_id: '10000001', inventory_number: 'INV-1', nka: 'NKA-1-0', nka_acq_date: '2024-01-10', serial_number: 'SN-1',
    superior_equipment: '20001', remarks: 'Data dummy 1', type_id: all.data[0].type_id, type_name: 'ROUTER - CISCO - ASR', category: 'IP Core', object_type: 'ROUTER',
    manufacturer: 'Cisco', model: 'ASR', part_number: 'ASR-20G', site_id: all.data[0].site_id, site_code: 'KLT', site_name: 'KLATEN', functional_location: 'TIF6-1520-SURAKARTA-KLT' });
});

test('endpoint inventaris: filter, pencarian, rentang tanggal, pagination, dan detail', async t => {
  const f = await fixture(); t.after(() => f.close());
  const admin = await f.login();
  await importInventory(f.db, [1, 2, 3, 4, 5, 6].map(row), false);
  const list = async (query: string) => { const res = await f.app.inject({ url: `/api/inventory?${query}`, headers: admin }); assert.equal(res.statusCode, 200, `${query} ${res.body}`);
    return { ids: res.json().data.map((x: any) => x.equipment_id.slice(-1)), total: res.json().meta.total }; };
  const sw = (await f.db.query("SELECT id FROM equipment_types WHERE object_type='SWITCH'")).rows[0].id;
  const skh = (await f.db.query("SELECT id FROM inventory_sites WHERE code='SKH'")).rows[0].id;

  assert.deepEqual(await list(`type_id=${sw}`), { ids: ['3', '6'], total: 2 });
  assert.deepEqual(await list(`site_id=${skh}`), { ids: ['2', '4', '6'], total: 3 });
  assert.deepEqual(await list('site_code=klt'), { ids: ['1', '5', '3'], total: 3 });
  assert.deepEqual(await list('category=transmission'), { ids: ['3', '6'], total: 2 });
  assert.deepEqual(await list('object_type=router&site_code=SKH'), { ids: ['2', '4'], total: 2 });
  assert.deepEqual(await list('search=sn-5'), { ids: ['5'], total: 1 });
  assert.deepEqual(await list('search=inv-2'), { ids: ['2'], total: 1 });
  assert.deepEqual(await list('search=NKA-3'), { ids: ['3'], total: 1 });
  assert.deepEqual(await list('search=1000000'), { ids: ['1', '5', '3', '2', '4', '6'], total: 6 });
  assert.deepEqual(await list('search=%25'), { ids: [], total: 0 });
  assert.deepEqual(await list('date_from=2024-02-01&date_to=2024-04-30'), { ids: ['3', '2', '4'], total: 3 });
  assert.deepEqual(await list('date_from=2024-06-01'), { ids: ['6'], total: 1 });
  assert.deepEqual(await list('limit=2&page=2'), { ids: ['3', '2'], total: 6 });
  assert.deepEqual(await list('limit=2&page=4'), { ids: [], total: 6 });

  const first = (await f.app.inject({ url: '/api/inventory?search=sn-1', headers: admin })).json().data[0];
  const detail = await f.app.inject({ url: `/api/inventory/${first.id}`, headers: admin });
  assert.equal(detail.statusCode, 200, detail.body);
  const d = detail.json().data;
  assert.equal(d.equipment_id, '10000001'); assert.ok(d.created_at && d.updated_at);
  assert.equal(d.type.manufacturer, 'Cisco'); assert.equal(d.type.part_number, 'ASR-20G');
  assert.equal(d.site.code, 'KLT'); assert.equal(d.site.cost_center, 'TF6O2000'); assert.equal(d.site.district_name, 'SURAKARTA'); assert.equal(d.site.territory, 'TIF6');
});

test('endpoint inventaris: validasi, 404, dan hak akses admin saja', async t => {
  const f = await fixture(); t.after(() => f.close());
  const admin = await f.login(); const tech = await f.login('teknisi');
  await importInventory(f.db, [1].map(row), false);
  const status = async (path: string, headers?: object) => (await f.app.inject({ url: path, headers: headers as any })).statusCode;

  for (const bad of ['limit=0', 'limit=101', 'page=0', 'type_id=abc', 'site_id=-1', 'date_from=2024-13-01', 'date_from=2024-05-01&date_to=2024-01-01', 'bukan=filter'])
    assert.equal(await status(`/api/inventory?${bad}`, admin), 422, bad);
  assert.equal(await status('/api/equipment-types?limit=0', admin), 422);
  assert.equal(await status('/api/inventory-sites?x=1', admin), 422);
  assert.equal(await status('/api/inventory/999999', admin), 404);
  assert.equal(await status('/api/inventory/abc', admin), 422);

  for (const path of ['/api/inventory', '/api/inventory/1', '/api/equipment-types', '/api/inventory-sites']) {
    assert.equal(await status(path, tech), 403, path);
    assert.equal(await status(path), 401, path);
  }
});
