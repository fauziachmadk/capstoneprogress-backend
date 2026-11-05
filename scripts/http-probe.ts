import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { loadConfig } from '../src/config.js';

// This probes an ALREADY RUNNING server over real HTTP, like a Postman client.
// It never starts Fastify or uses inject(), and never records credentials in output.
const config=loadConfig();
const base=(process.env.API_BASE_URL||`http://127.0.0.1:${config.PORT}`).replace(/\/$/,'');
const target=new URL(base);
if(!['127.0.0.1','localhost','[::1]'].includes(target.hostname))throw new Error('Probe ini dibatasi ke server lokal.');
const timeout=15000;
type Headers=Record<string,string>;
type Result={method:string;path:string;expected:number;status:number|null;elapsed_ms:number;passed:boolean;error?:string;total?:number;bytes?:number};
const results:Result[]=[];
const sessions:Headers[]=[];
let officeId:number|undefined;
let admin:Headers|undefined;
let failure:string|undefined;
const suffix=randomBytes(6).toString('hex').toUpperCase();
async function hit(method:string,path:string,expected=200,headers:Headers={},body?:object|FormData,binary=false){
  const start=performance.now();
  let result:Result;
  try{
    const form=body instanceof FormData;
    const response=await fetch(base+path,{method,headers:{...headers,...(body&&!form?{'Content-Type':'application/json'}:{})},
      body:body?form?body:JSON.stringify(body):undefined,signal:AbortSignal.timeout(timeout)});
    const bytes=binary?new Uint8Array(await response.arrayBuffer()):undefined;
    const data=binary||response.status===204?undefined:await response.json() as any;
    result={method,path,expected,status:response.status,elapsed_ms:Math.round(performance.now()-start),passed:response.status===expected,
      ...(data?.error?.code?{error:data.error.code}:{}),...(typeof data?.meta?.total==='number'?{total:data.meta.total}:{}),...(bytes?{bytes:bytes.byteLength}:{})};
    if(binary&&response.status===200&&(!bytes||bytes[0]!==80||bytes[1]!==75)){result.passed=false;result.error='Invalid XLSX response';}
    results.push(result);console.log(JSON.stringify(result));return {response,data,result};
  }catch(error){
    const e=error as Error&{cause?:{code?:string}};
    result={method,path,expected,status:null,elapsed_ms:Math.round(performance.now()-start),passed:false,error:e.cause?.code||e.name};
    results.push(result);console.log(JSON.stringify(result));return {response:undefined,data:undefined,result};
  }
}
function requirePass(result:Result){if(!result.passed)throw new Error(`${result.method} ${result.path}: ${result.error||result.status}`);}
async function login(username:string,password:string|undefined){
  if(!password)throw new Error('Lengkapi password seed di .env.local.');
  const request=await hit('POST','/api/auth/login',200,{}, {username,password});requirePass(request.result);
  const cookie=request.response!.headers.getSetCookie().find(v=>v.startsWith('caps2tone_session='))?.split(';')[0];
  if(!cookie||!request.data?.data?.csrf_token)throw new Error('Login tidak menghasilkan sesi/CSRF.');
  const headers={cookie,'x-csrf-token':request.data.data.csrf_token};sessions.push(headers);return headers;
}
try{
  requirePass((await hit('GET','/health')).result);
  await hit('GET','/docs/json');
  await hit('GET','/api/assets',401);
  admin=await login(process.env.SEED_ADMIN_USERNAME||'admin',process.env.SEED_ADMIN_PASSWORD);
  const reads=await Promise.all(['/api/auth/me','/api/users','/api/offices','/api/assets?search=DEMO','/api/schedules',
    '/api/dashboard/summary','/api/dashboard/progress','/api/reports/mapping','/api/notifications/logs']
    .map(path=>hit('GET',path,200,admin)));
  reads.forEach(r=>requirePass(r.result));
  const assets=reads[3].data.data as any[];
  const sample=assets.find(a=>a.kind==='chassis');
  if(sample){
    await hit('GET',`/api/assets/${sample.id}`,200,admin);
    await hit('GET',`/api/assets/${sample.id}/history`,200,admin);
  }
  await hit('GET','/api/assets/export?search=DEMO',200,admin,undefined,true);
  await hit('GET','/api/reports/mapping/export',200,admin,undefined,true);
  await hit('POST','/api/assets',422,admin,{});
  await hit('POST','/api/users',422,admin,{});
  await hit('POST','/api/scan/match',403,admin,{});
  await hit('POST','/api/offices',403,{cookie:admin.cookie},{code:`PROBE-${suffix}`,name:'CSRF probe',area:'grobogan'});
  const created=await hit('POST','/api/offices',201,admin,{code:`PROBE-${suffix}`,name:'[HTTP PROBE] temporary office',area:'grobogan'});
  requirePass(created.result);officeId=created.data.data.id;
  requirePass((await hit('PATCH',`/api/offices/${officeId}`,200,admin,{address:'HTTP POST/PATCH verification'})).result);
  const readBack=await hit('GET',`/api/offices/${officeId}`,200,admin);requirePass(readBack.result);
  if(readBack.data.data.address!=='HTTP POST/PATCH verification')throw new Error('Office write/read mismatch');
  // Exercise multipart + database transaction without leaving an imported asset.
  if(sample){
    const book=new ExcelJS.Workbook();const sheet=book.addWorksheet('Aset');
    sheet.addRow(['EQ','Jenis','Serial Number','Kode Kantor']);
    sheet.addRow([`PROBE-${suffix}`,'Chassis',`PROBE-SN-${suffix}`,sample.office_code]);
    const form=new FormData();form.set('file',new Blob([Uint8Array.from(Buffer.from(await book.xlsx.writeBuffer()))]),'probe.xlsx');
    const preview=await hit('POST','/api/assets/import?dry_run=true',200,admin,form);requirePass(preview.result);
    if(preview.data.data.created!==1)throw new Error('Unexpected import preview');
    const absent=await hit('GET',`/api/assets?search=PROBE-${suffix}`,200,admin);requirePass(absent.result);
    if(absent.data.meta.total!==0)throw new Error('Dry-run asset was persisted');
  }
  const tech=await login('teknisi.grobogan',process.env.SEED_TECHNICIAN_PASSWORD);
  await hit('GET','/api/auth/me',200,tech);
  await hit('GET','/api/assets',403,tech);
  const schedules=await hit('GET','/api/schedules',200,tech);requirePass(schedules.result);
  const schedule=schedules.data.data.find((s:any)=>['terjadwal','berjalan'].includes(s.status));
  if(schedule){
    const own=await hit('GET',`/api/technician/assets?schedule_id=${schedule.id}`,200,tech);requirePass(own.result);
    await hit('GET',`/api/technician/chassis?schedule_id=${schedule.id}`,200,tech);
    const records=own.data.data as any[];
    const chassis=records.find(a=>a.kind==='chassis');
    if(chassis){
      await hit('GET',`/api/technician/chassis/${chassis.id}/modules?schedule_id=${schedule.id}`,200,tech);
      const found=await hit('POST','/api/scan/match',200,tech,{schedule_id:schedule.id,serial_number:chassis.serial_number});requirePass(found.result);
      if(found.data.data.result!=='found')throw new Error('Expected found');
    }
    const duplicate=records.find(a=>records.filter(b=>b.serial_number===a.serial_number).length>1);
    if(duplicate){
      const multiple=await hit('POST','/api/scan/match',200,tech,{schedule_id:schedule.id,serial_number:duplicate.serial_number});requirePass(multiple.result);
      if(multiple.data.data.result!=='multiple')throw new Error('Expected multiple');
    }
    const missing=await hit('POST','/api/scan/match',200,tech,{schedule_id:schedule.id,serial_number:`PROBE-UNKNOWN-${suffix}`});requirePass(missing.result);
    if(missing.data.data.result!=='not_found')throw new Error('Expected not_found');
    await hit('POST','/api/mapping-results',422,tech,{schedule_id:schedule.id,scanned_sn:''});
  }else throw new Error('Tidak ada jadwal teknisi aktif hari ini; perbarui DEMO bila ingin menguji scan.');
  await hit('GET','/api/cron/notify-schedule',401);
}catch(error){failure=(error as Error).message;process.exitCode=1;}
finally{
  if(officeId&&admin){
    const removed=await hit('DELETE',`/api/offices/${officeId}`,204,admin);
    if(removed.result.passed)await hit('GET',`/api/offices/${officeId}`,404,admin);
  }
  for(const session of sessions){await hit('POST','/api/auth/logout',200,session);await hit('GET','/api/auth/me',401,session);}
  const passed=results.filter(r=>r.passed).length;
  const report={tested_at:new Date().toISOString(),base_url:base,transport:'real HTTP to already-running server',timeout_ms:timeout,
    passed,failed:results.length-passed,status:!failure&&passed===results.length?'passed':'failed',...(failure?{failure}:{}),results};
  if(report.status!=='passed')process.exitCode=1;
  await writeFile('docs/http-probe-report.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,passed:report.passed,failed:report.failed,report:'docs/http-probe-report.json',...(failure?{failure}:{})}));
}
