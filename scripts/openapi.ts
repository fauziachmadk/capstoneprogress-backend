import { readFile,writeFile } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { loadConfig,today } from '../src/config.js';
import type { Database } from '../src/db.js';
import { apiContracts } from '../src/contracts.js';
const db: Database = {
  query: async () => { throw new Error('Generator dokumentasi tidak mengakses database.'); },
  transaction: async () => { throw new Error('Generator dokumentasi tidak mengakses database.'); },
  close: async () => {},
};
const app = await buildApp({ db, config: loadConfig({ DATABASE_URL: 'postgresql://docs:docs@localhost/docs', AUTH_SECRET: 'documentation-only-placeholder-secret', NODE_ENV: 'test' }) });
await writeFile('docs/openapi.json', JSON.stringify(app.swagger(), null, 2) + '\n');
let demo: any;
try { demo=JSON.parse(await readFile('docs/demo-data.json','utf8')).records?.[0]; } catch { /* Demo data is optional. */ }
const defaults: Record<string,string>={base_url:'http://127.0.0.1:3001',username:process.env.SEED_ADMIN_USERNAME||'admin',
  scheduled_date:today('Asia/Jakarta'),office_id:String(demo?.office_id??''),schedule_id:String(demo?.schedule_id??''),
  technician_id:String(demo?.technician_id??''),user_id:String(demo?.technician_id??''),asset_id:String(demo?.assets?.[0]?.id??''),chassis_id:String(demo?.assets?.[0]?.id??'')};
const collection = {
  info: { name: 'Caps2Tone Backend', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', description: 'Pilih request yang diperlukan. Login dahulu; cookie jar menyimpan sesi dan test script menyimpan CSRF. Isi variabel ID setelah membuat/membaca data. Request mutasi mengubah database.' },
  variable: ['base_url', 'username', 'password', 'new_user_password', 'csrf_token', 'asset_id', 'chassis_id', 'user_id', 'telegram_chat_id', 'office_id', 'schedule_id', 'technician_id', 'scheduled_date', 'cron_secret'].map(key => ({ key, value: defaults[key]??'' })),
  item: apiContracts.map(contract => {
    const key = contract.path.includes('schedules') ? 'schedule_id' : contract.path.includes('offices') ? 'office_id' : contract.path.includes('/users') ? 'user_id' : contract.path.includes('/chassis') ? 'chassis_id' : 'asset_id';
    const path = contract.path.replace(':id', `{{${key}}}`);
    const query = Object.keys(contract.query?.properties ?? {}).filter(k => contract.query?.required?.includes(k) || k === 'dry_run' || (contract.method === 'DELETE' && k === 'id'))
      .map(k => ({ key: k, value: k === 'dry_run' ? 'true' : `{{${k === 'id' ? key : k}}}` }));
    const cron = path.startsWith('/api/cron/');
    const header = cron ? [{ key: 'Authorization', value: 'Bearer {{cron_secret}}' }]
      : [{ key: 'X-CSRF-Token', value: '{{csrf_token}}' }, ...(contract.example ? [{ key: 'Content-Type', value: 'application/json' }] : [])];
    return {
      name: `${contract.method} ${contract.path} — ${contract.summary}`,
      request: { method: contract.method, header, description: contract.roles,
        url: { raw: `{{base_url}}${path}${query.length ? '?' + query.map(q => `${q.key}=${q.value}`).join('&') : ''}`, host: ['{{base_url}}'], path: path.slice(1).split('/'), query },
        ...(contract.path === '/api/assets/import' ? { body: { mode: 'formdata', formdata: [{ key: 'file', type: 'file', src: [] }] } }
          : contract.example ? { body: { mode: 'raw', raw: JSON.stringify(contract.example, null, 2), options: { raw: { language: 'json' } } } } : {}),
      },
      ...(contract.path === '/api/auth/login' || contract.path === '/api/auth/me' ? { event: [{ listen: 'test', script: { type: 'text/javascript', exec: ["if (pm.response.code === 200) pm.collectionVariables.set('csrf_token', pm.response.json().data.csrf_token);"] } }] }
        : contract.method==='POST' && ['/api/users','/api/offices','/api/assets','/api/schedules'].includes(contract.path)
          ? {event:[{listen:'test',script:{type:'text/javascript',exec:[`if (pm.response.code === 201) { const d=pm.response.json().data; pm.collectionVariables.set('${key}',String(d.id));${contract.path==='/api/assets'?" if(d.kind==='chassis') pm.collectionVariables.set('chassis_id',String(d.id));":''}${contract.path==='/api/users'?" if(d.role==='teknisi') pm.collectionVariables.set('technician_id',String(d.id));":''} }`]}}]}
          : {}),
    };
  }),
};
await writeFile('docs/Caps2Tone.postman_collection.json', JSON.stringify(collection, null, 2) + '\n');
await app.close();
console.log('OpenAPI dan koleksi Postman dibuat di docs/.');
