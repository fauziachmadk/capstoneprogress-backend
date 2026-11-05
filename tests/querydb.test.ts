import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { fixture } from './helpers.js';
import { verifyPassword } from '../src/auth.js';

test('migrasi queryDB mempertahankan UUID lama, semua relasi, password, scan, dan riwayat',async()=>{
  const db=new PGlite();
  try{
    await db.exec(await readFile(new URL('../migrations/001_initial.sql',import.meta.url),'utf8'));
    const user=(await db.query<{id:string}>("INSERT INTO users(name,username,password_hash,role) VALUES('Legacy','legacy','keep-this-hash','teknisi') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO technician_areas(user_id,area) VALUES($1,'grobogan')",[user]);
    const office=(await db.query<{id:string}>("INSERT INTO offices(code,name,area) VALUES('OLD','Legacy','grobogan') RETURNING id")).rows[0].id;
    const chassis=(await db.query<{id:string}>("INSERT INTO assets(eq,kind,serial_number,office_id) VALUES('OLD-C','chassis','OLD-C',$1) RETURNING id",[office])).rows[0].id;
    const module=(await db.query<{id:string}>("INSERT INTO assets(eq,kind,serial_number,office_id,parent_id) VALUES('OLD-M','module','OLD-M',$1,$2) RETURNING id",[office,chassis])).rows[0].id;
    const schedule=(await db.query<{id:string}>("INSERT INTO mapping_schedules(office_id,area,scheduled_date,assigned_to,created_by) VALUES($1,'grobogan',CURRENT_DATE,$2,$2) RETURNING id",[office,user])).rows[0].id;
    await db.query("INSERT INTO mapping_results(schedule_id,asset_id,scanned_sn,result,scanned_by) VALUES($1,$2,'OLD-M','found',$3)",[schedule,module,user]);
    await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('legacy-token',$1,now()+interval '1 hour')",[user]);
    await db.transaction(async tx=>{await tx.query("SELECT set_config('app.actor_id',$1,true)",[user]);await tx.query("UPDATE assets SET condition='Baik' WHERE id=$1",[module]);});
    await db.exec(await readFile(new URL('../migrations/002_align_querydb.sql',import.meta.url),'utf8'));
    const users=(await db.query<any>('SELECT id,legacy_id,password_hash,areas::text[] AS areas,is_active FROM users')).rows[0];
    assert.equal(typeof users.id,'number');assert.equal(users.legacy_id,user);assert.equal(users.password_hash,'keep-this-hash');assert.deepEqual(users.areas,['grobogan']);assert.equal(users.is_active,true);
    const asset=(await db.query<any>("SELECT a.id,a.kondisi,p.legacy_id AS parent FROM assets a JOIN assets p ON p.id=a.parent_id WHERE a.eq='OLD-M'")).rows[0];
    assert.equal(asset.kondisi,'Baik');assert.equal(asset.parent,chassis);
    const history=(await db.query<any>('SELECT field,changed_by,asset_id FROM asset_history')).rows[0];
    assert.equal(history.field,'kondisi');assert.equal(history.changed_by,users.id);assert.equal(history.asset_id,asset.id);
    assert.equal((await db.query<any>('SELECT user_id FROM sessions')).rows[0].user_id,users.id);
    const scan=(await db.query<any>('SELECT r.asset_id,r.scanned_by,s.legacy_id AS schedule FROM mapping_results r JOIN mapping_schedules s ON s.id=r.schedule_id')).rows[0];
    assert.equal(scan.asset_id,asset.id);assert.equal(scan.scanned_by,users.id);assert.equal(scan.schedule,schedule);
  }finally{await db.close();}
});
test('JSON pengguna: bcrypt, areas, chat ID, nonaktifkan sesi, admin terakhir',async t=>{
  const f=await fixture();t.after(()=>f.close());const admin=await f.login();
  const response=await f.app.inject({method:'POST',url:'/api/users',headers:admin,payload:{name:'Baru',username:' NEW.TECH ',password:'password-for-new-user',role:'teknisi',areas:['grobogan','solo']}});
  assert.equal(response.statusCode,201,response.body);const user=response.json().data;
  assert.equal(typeof user.id,'number');assert.deepEqual(user.areas,['grobogan','solo']);assert.equal(user.password_hash,undefined);
  const hash=(await f.db.query('SELECT password_hash FROM users WHERE id=$1',[user.id])).rows[0].password_hash;
  assert.match(hash,/^\$2/);assert.equal(await verifyPassword('password-for-new-user',hash),true);
  const logged=await f.app.inject({method:'POST',url:'/api/auth/login',payload:{username:'new.tech',password:'password-for-new-user'}});
  assert.equal(logged.statusCode,200);const cookie=`caps2tone_session=${logged.cookies[0].value}`;
  const changed=await f.app.inject({method:'PATCH',url:`/api/users/${user.id}`,headers:admin,payload:{telegram_chat_id:'123456',is_active:false}});
  assert.equal(changed.statusCode,200,changed.body);
  assert.equal((await f.app.inject({url:'/api/auth/me',headers:{cookie}})).statusCode,401);
  assert.equal((await f.app.inject({method:'POST',url:'/api/auth/login',payload:{username:'new.tech',password:'password-for-new-user'}})).statusCode,401);
  assert.equal((await f.app.inject({method:'PATCH',url:`/api/users/${f.admin}`,headers:admin,payload:{is_active:false}})).statusCode,409);
  const active=await f.app.inject({url:'/api/users?is_active=false',headers:admin});assert.equal(active.statusCode,200,active.body);assert.equal(active.json().meta.total,1);
});
test('JSON aset: kolom kondisi dan alias lama, empty strings, progres chassis/modul',async t=>{
  const f=await fixture();t.after(()=>f.close());const admin=await f.login();const tech=await f.login('teknisi');
  let r=await f.app.inject({method:'POST',url:'/api/assets',headers:admin,payload:{kind:'module',eq:'NEW-MOD',serial_number:' new-sn ',office_id:f.office,parent_id:f.asset,condition:'Baik'}});
  assert.equal(r.statusCode,201,r.body);const a=r.json().data;assert.equal(a.kondisi,'Baik');assert.equal(a.condition,'Baik');assert.equal(a.serial_number,'NEW-SN');assert.equal(a.ref,'');
  assert.equal((await f.app.inject({url:`/api/assets/${a.id}`,headers:admin})).json().data.kondisi,'Baik');
  r=await f.app.inject({method:'PATCH',url:`/api/assets/${a.id}`,headers:admin,payload:{condition:'Rusak',ref:null}});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().data.kondisi,'Rusak');assert.equal(r.json().data.ref,'');
  assert.equal((await f.app.inject({url:`/api/assets/${a.id}/history`,headers:admin})).json().data[0].field,'kondisi');
  r=await f.app.inject({url:`/api/technician/chassis?schedule_id=${f.schedule}`,headers:tech});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().data[0].total_modules,1);
  r=await f.app.inject({url:`/api/technician/chassis/${f.asset}/modules?schedule_id=${f.schedule}`,headers:tech});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().meta.total,1);
  assert.equal((await f.app.inject({method:'POST',url:'/api/assets',headers:tech,payload:{}})).statusCode,403);
});
test('jadwal tanpa penugasan tersedia hanya pada area teknisi dan dapat dipindai',async t=>{
  const f=await fixture();t.after(()=>f.close());const tech=await f.login('teknisi');
  await f.db.query('UPDATE mapping_schedules SET assigned_to=NULL WHERE id=$1',[f.schedule]);
  const schedules=await f.app.inject({url:'/api/schedules',headers:tech});assert.equal(schedules.statusCode,200,schedules.body);assert.equal(schedules.json().meta.total,1);
  const scan=await f.app.inject({method:'POST',url:'/api/mapping-results',headers:tech,payload:{schedule_id:f.schedule,scanned_sn:'SN-001'}});assert.equal(scan.statusCode,201,scan.body);
  assert.equal((await f.app.inject({url:'/api/schedules',headers:await f.login('lain')})).json().meta.total,0);
});
test('laporan memakai tanggal scan, bukan tanggal jadwal; percent hanya aset sudah',async t=>{
  const f=await fixture();t.after(()=>f.close());const headers=await f.login();
  await f.db.query("UPDATE mapping_schedules SET scheduled_date='2000-01-01' WHERE id=$1",[f.schedule]);
  await f.db.query("INSERT INTO mapping_results(schedule_id,asset_id,scanned_sn,result,scanned_by) VALUES($1,$2,'SN-001','found',$3)",[f.schedule,f.asset,f.tech]);
  const result=await f.app.inject({url:`/api/reports/mapping?date_from=${f.day}&date_to=${f.day}`,headers});assert.equal(result.statusCode,200,result.body);assert.equal(result.json().meta.total,1);
  await f.db.query("UPDATE assets SET mapping_status='tidak_ditemukan' WHERE id=$1",[f.asset]);
  const progress=await f.app.inject({url:`/api/dashboard/progress?office_id=${f.office}`,headers});assert.equal(progress.json().data[0].percent,0);assert.equal(progress.json().data[0].progress_percent,100);
  assert.equal((await f.app.inject({url:'/api/dashboard/summary',headers})).json().data.total,2);
});
test('not_found dapat menunjuk aset inventaris yang diharapkan dalam kantor sendiri',async t=>{
  const f=await fixture();t.after(()=>f.close());const headers=await f.login('teknisi');
  const result=await f.app.inject({method:'POST',url:'/api/mapping-results',headers,payload:{schedule_id:f.schedule,scanned_sn:'SN-TIDAK-COCOK',asset_id:f.asset}});
  assert.equal(result.statusCode,201,result.body);assert.equal(result.json().data.result,'not_found');assert.equal(result.json().data.asset_id,f.asset);
  assert.equal((await f.db.query('SELECT mapping_status FROM assets WHERE id=$1',[f.asset])).rows[0].mapping_status,'tidak_ditemukan');
});
test('query INSERT notification_logs dari queryDB bekerja tanpa dedupe_key eksplisit',async t=>{
  const f=await fixture();t.after(()=>f.close());
  const row=(await f.db.query("INSERT INTO notification_logs(type,payload,success) VALUES('hasil_harian','{}',false) RETURNING id,dedupe_key,sent_at")).rows[0];
  assert.equal(typeof row.id,'number');assert.ok(row.dedupe_key);assert.ok(row.sent_at);
});
