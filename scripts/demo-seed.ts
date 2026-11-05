import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { loadConfig, today } from '../src/config.js';
import { createDatabase } from '../src/db.js';

const config=loadConfig();
// This workspace's explicitly approved demo target. Never seed its main branch.
const endpoint=new URL(config.DATABASE_URL).hostname.split('.')[0].replace('-pooler','');
if(config.NODE_ENV!=='development' || endpoint!=='ep-late-sun-azjgrwia') throw new Error('Data DEMO hanya diizinkan pada endpoint Neon dev proyek ini.');
const db=createDatabase(config.DATABASE_URL);
const app=await buildApp({db,config});
const sessions: Record<string,string>[]=[];
const records: any[]=[];
try{
  const base=await app.listen({host:'127.0.0.1',port:0});
  async function api(method:string,path:string,headers:Record<string,string>,body?:object,expected=200){
    const response=await fetch(base+path,{method,headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    const payload=await response.json() as any;
    assert.equal(response.status,expected,`${method} ${path}: ${payload.error?.code??'unexpected response'}`);
    return payload;
  }
  async function login(username:string,password:string|undefined){
    if(!password)throw new Error('Lengkapi password seed di .env.local.');
    const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
    assert.equal(response.status,200,`Login ${username} gagal; password akun lama tidak ditimpa.`);
    const payload=await response.json() as any;
    const headers={cookie:response.headers.getSetCookie().find(v=>v.startsWith('caps2tone_session='))!.split(';')[0],'x-csrf-token':payload.data.csrf_token};
    sessions.push(headers);return headers;
  }
  const admin=await login(process.env.SEED_ADMIN_USERNAME||'admin',process.env.SEED_ADMIN_PASSWORD);
  for(const [code,area,username] of [['GRB','grobogan','teknisi.grobogan'],['SLO','solo','teknisi.solo']] as const){
    const officeCode=`DEMO-${code}`;
    const found=(await api('GET',`/api/offices?search=${officeCode}`,admin)).data.find((o:any)=>o.code===officeCode);
    const office=found??(await api('POST','/api/offices',admin,{code:officeCode,name:`[DEMO] Kantor ${area==='solo'?'Solo':'Grobogan'}`,address:'Data contoh pengembangan, bukan aset operasional',area},201)).data;
    assert.ok(office.name.startsWith('[DEMO]'),'Kode DEMO sudah digunakan oleh kantor lain.');
    const existing=(await api('GET',`/api/assets?office_id=${office.id}&limit=100`,admin)).data;
    const assets:any[]=[];
    for(const index of [1,2,3]){
      const eq=`DEMO-${code}-${index===1?'CHASSIS':`MODUL-${index-1}`}`;
      let asset=existing.find((a:any)=>a.eq===eq);
      if(asset){assert.ok(asset.asset_code.startsWith('DEMO-'),'EQ DEMO sudah digunakan aset lain.');}
      else asset=(await api('POST','/api/assets',admin,{kind:index===1?'chassis':'module',eq,serial_number:index===1?`DEMO-SN-${code}-CHASSIS`:`DEMO-SN-${code}-MODUL-GANDA`,parent_id:index===1?null:assets[0].id,office_id:office.id,ref:'DEMO-REF',status:'Aktif',kondisi:'Baik',asset_code:eq},201)).data;
      assets.push(asset);
    }
    if(assets[0].ref==='DEMO-REF')await api('PATCH',`/api/assets/${assets[0].id}`,admin,{ref:'DEMO-REF-TERVERIFIKASI'});
    const users=(await api('GET',`/api/users?role=teknisi&area=${area}&is_active=true`,admin)).data;
    const technician=users.find((u:any)=>u.username===username);
    assert.ok(technician,`Jalankan db:seed untuk akun ${username}.`);
    const schedules=(await api('GET',`/api/schedules?office_id=${office.id}&date=${today(config.APP_TIMEZONE)}`,admin)).data;
    const schedule=schedules.find((s:any)=>['terjadwal','berjalan'].includes(s.status))??schedules[0]??(await api('POST','/api/schedules',admin,{office_id:office.id,area,scheduled_date:today(config.APP_TIMEZONE),assigned_to:technician.id},201)).data;
    if(['terjadwal','berjalan'].includes(schedule.status)){
      assert.equal(schedule.assigned_to,technician.id,'Jadwal DEMO telah dialihkan; penugasan tidak ditimpa.');
      const tech=await login(username,process.env.SEED_TECHNICIAN_PASSWORD);
      const scans=(await api('GET',`/api/reports/mapping?schedule_id=${schedule.id}&limit=100`,admin)).data;
      const inputs=[
        {scanned_sn:assets[0].serial_number,label_attached:true,label_code:`DEMO-LABEL-${code}`,result:'found'},
        {scanned_sn:assets[1].serial_number,label_attached:false,result:'multiple'},
        {scanned_sn:`DEMO-SN-${code}-TIDAK-DIKENAL`,asset_id:assets[2].id,label_attached:false,result:'not_found'},
      ];
      for(const input of inputs){
        if(scans.some((s:any)=>s.scanned_sn===input.scanned_sn&&s.result===input.result))continue;
        const {result,...payload}=input;
        const saved=(await api('POST','/api/mapping-results',tech,{schedule_id:schedule.id,...payload},201)).data;
        assert.equal(saved.result,result);
      }
    }
    records.push({office_id:office.id,office_code:officeCode,area,technician_id:technician.id,technician_username:username,schedule_id:schedule.id,
      assets:assets.map(a=>({id:a.id,eq:a.eq,serial_number:a.serial_number,kind:a.kind})),unknown_sn:`DEMO-SN-${code}-TIDAK-DIKENAL`});
  }
  await db.query(`INSERT INTO notification_logs(type,dedupe_key,payload,sent_at,success) VALUES('demo_verification','demo:bootstrap',$1::jsonb,NULL,false)
    ON CONFLICT(dedupe_key) DO NOTHING`,[JSON.stringify({demo:true,no_message_sent:true,note:'Contoh log pengembangan; bukan pengiriman Telegram.'})]);
  // Read from a separate pool after the actual HTTP handlers have committed.
  const verification=createDatabase(config.DATABASE_URL);
  let counts;
  try{
    counts=(await verification.query(`SELECT
      (SELECT count(*)::int FROM offices WHERE id=ANY($1::integer[])) AS offices,
      (SELECT count(*)::int FROM assets WHERE office_id=ANY($1::integer[])) AS assets,
      (SELECT count(*)::int FROM mapping_schedules WHERE office_id=ANY($1::integer[])) AS schedules,
      (SELECT count(*)::int FROM mapping_results WHERE schedule_id=ANY($2::integer[])) AS scans,
      (SELECT count(*)::int FROM asset_history h JOIN assets a ON a.id=h.asset_id WHERE a.office_id=ANY($1::integer[])) AS history`,[records.map(r=>r.office_id),records.map(r=>r.schedule_id)])).rows[0];
    assert.equal(counts.offices,2);assert.equal(counts.assets,6);assert.ok(counts.scans>=6);
  }finally{await verification.close();}
  const report={created_or_verified_at:new Date().toISOString(),branch:'dev-backend-fastify',demo:true,committed:true,telegram_messages_sent:0,counts,records};
  await writeFile('docs/demo-data.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}finally{
  const address=app.server.address();
  if(address&&typeof address!=='string')for(const headers of sessions){await fetch(`http://127.0.0.1:${address.port}/api/auth/logout`,{method:'POST',headers}).catch(()=>{});}
  await app.close();await db.close();
}
