// These schemas describe the API for Swagger/Postman. Runtime validation uses Zod in each handler.
type Schema = Record<string, any>;
type Contract = { method: string; path: string; summary: string; roles: string; body?: Schema; query?: Schema; example?: unknown; binary?: boolean };
const entityId = { type: 'integer', minimum: 1, maximum: 2147483647 };
const string = { type: 'string', minLength: 1, maxLength: 255 };
const nullableString = { ...string, nullable: true };
const area = { type: 'string', enum: ['grobogan', 'solo'] };
const date = { type: 'string', format: 'date' };
const status = { type: 'string', enum: ['terjadwal', 'berjalan', 'selesai', 'dibatalkan'] };
const bool = { type: 'boolean' };
const object = (properties: Schema, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const page = { page: { type: 'integer', minimum: 1, default: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 } };
const assetQuery = { ...page, search: string, office_id: entityId, kind: { type: 'string', enum: ['chassis', 'module'] }, parent_id: entityId,
  mapping_status: { type: 'string', enum: ['belum', 'sudah', 'tidak_ditemukan'] } };
const schedule = { office_id: entityId, area, scheduled_date: date, assigned_to: { ...entityId, nullable: true }, status };
const office = { code: string, name: string, address: { type: 'string', maxLength: 1000 }, area: {...area,nullable:true} };
const report = { ...page, office_id: entityId, schedule_id: entityId, date_from: date, date_to: date };
export const apiContracts: Contract[] = [
  { method:'GET',path:'/health',summary:'Ping API dan koneksi database',roles:'Publik. Respons 200 dengan data.status=ok.' },
  { method: 'POST', path: '/api/auth/login', summary: 'Login dengan username/password', roles: 'Publik. Cookie sesi 8 jam; simpan csrf_token untuk mutasi.', body: object({ username: string, password: { type: 'string', maxLength: 1024 } }, ['username', 'password']), example: { username: '{{username}}', password: '{{password}}' } },
  { method: 'POST', path: '/api/auth/logout', summary: 'Cabut sesi saat ini', roles: 'Admin / teknisi; memerlukan X-CSRF-Token.' },
  { method: 'GET', path: '/api/auth/me', summary: 'Pengguna, area dan CSRF sesi saat ini', roles: 'Admin / teknisi.' },
  { method: 'GET', path: '/api/users', summary: 'Daftar pengguna untuk penugasan', roles: 'Admin.', query: object({ ...page, role: { type: 'string', enum: ['admin', 'teknisi'] }, area,is_active:{type:'string',enum:['true','false']} }) },
  { method: 'POST', path: '/api/users', summary: 'Buat akun dengan hash bcrypt dan area layanan', roles: 'Admin.', body: object({name:string,username:string,password:{type:'string',minLength:12,maxLength:72},role:{type:'string',enum:['admin','teknisi']},areas:{type:'array',items:area,maxItems:2,uniqueItems:true},is_active:bool,telegram_chat_id:{type:'string',nullable:true}},['name','username','password','role']),example:{name:'Teknisi Baru',username:'teknisi.baru',password:'{{new_user_password}}',role:'teknisi',areas:['grobogan']} },
  { method: 'PATCH', path: '/api/users/:id', summary: 'Ubah profil, area, chat ID atau status aktif akun', roles: 'Admin. Sesi dicabut ketika password, role, area atau status aktif berubah; admin aktif terakhir dilindungi.', body: object({name:string,username:string,password:{type:'string',minLength:12,maxLength:72},role:{type:'string',enum:['admin','teknisi']},areas:{type:'array',items:area,maxItems:2,uniqueItems:true},is_active:bool,telegram_chat_id:{type:'string',nullable:true}}),example:{telegram_chat_id:'{{telegram_chat_id}}'} },
  { method: 'GET', path: '/api/offices', summary: 'Daftar kantor', roles: 'Admin; teknisi hanya kantor penugasannya.', query: object({ ...page, area, search: string }) },
  { method: 'POST', path: '/api/offices', summary: 'Buat kantor', roles: 'Admin.', body: object(office, ['code', 'name']), example: { code: 'KTR-NEW', name: 'Kantor Baru', area: 'grobogan', address: '' } },
  { method: 'GET', path: '/api/offices/:id', summary: 'Detail kantor', roles: 'Admin / teknisi; teknisi dibatasi kantor penugasannya.' },
  { method: 'PATCH', path: '/api/offices/:id', summary: 'Perbarui kantor', roles: 'Admin. Area kantor dengan jadwal tidak dapat diganti.', body: object(office), example: { name: 'Kantor Diperbarui' } },
  { method: 'DELETE', path: '/api/offices/:id', summary: 'Hapus kantor yang belum dipakai', roles: 'Admin; referensi aset/jadwal mencegah penghapusan.' },
  { method: 'GET', path: '/api/assets', summary: 'Pencarian dan daftar aset', roles: 'Admin.', query: object(assetQuery) },
  { method: 'GET', path: '/api/assets/:id', summary: 'Detail aset dengan kondisi sesuai queryDB.md', roles: 'Admin.' },
  { method: 'POST', path: '/api/assets', summary: 'Tambah satu aset melalui JSON', roles: 'Admin. ID integer, SN dinormalisasi, parent_id harus menunjuk chassis sekantor. condition merupakan alias kompatibilitas kondisi.', body: object({kind:{type:'string',enum:['chassis','module']},eq:string,serial_number:string,office_id:entityId,parent_id:{...entityId,nullable:true},ref:{type:'string'},status:{type:'string'},kondisi:{type:'string'},condition:{type:'string'},asset_code:{type:'string'}},['kind','eq','serial_number','office_id']),example:{kind:'chassis',eq:'EQ-BARU',serial_number:'SN-BARU',office_id:'{{office_id}}',ref:'',status:'Aktif',kondisi:'Baik',asset_code:''} },
  { method: 'GET', path: '/api/technician/assets', summary: 'Aset di kantor jadwal teknisi', roles: 'Teknisi; schedule_id milik sendiri atau belum ditugaskan di area layanannya.', query: object({ ...assetQuery, schedule_id: entityId }, ['schedule_id']) },
  { method:'GET',path:'/api/technician/chassis',summary:'Daftar chassis dan progres modul',roles:'Teknisi. Jadwal dan area layanan divalidasi.',query:object({...page,schedule_id:entityId},['schedule_id']) },
  { method:'GET',path:'/api/technician/chassis/:id/modules',summary:'Daftar modul dalam satu chassis',roles:'Teknisi. Chassis harus berada di kantor jadwal.',query:object({...page,schedule_id:entityId},['schedule_id']) },
  { method: 'PATCH', path: '/api/assets/:id', summary: 'Ubah REF/STATUS/KONDISI secara atomik dengan audit', roles: 'Admin / teknisi. Teknisi wajib menyertakan schedule_id aktif hari ini. kondisi mengikuti konfigurasi izin; condition diterima sebagai alias. null dinormalisasi menjadi string kosong.', body: object({ ref: nullableString, status: nullableString, kondisi: nullableString, condition:nullableString,schedule_id: entityId }), example: { ref: 'REF-BARU', status: 'Aktif',kondisi:'Baik' } },
  { method: 'GET', path: '/api/assets/:id/history', summary: 'Riwayat perubahan aset', roles: 'Admin. field KONDISI bernama kondisi.', query: object(page) },
  { method: 'GET', path: '/api/assets/export', summary: 'Ekspor XLSX sesuai filter', roles: 'Admin; maksimal 10.000 baris. page/limit tidak membatasi ekspor.', query: object(assetQuery), binary: true },
  { method: 'POST', path: '/api/assets/import', summary: 'Pratinjau atau simpan impor XLSX atomik', roles: 'Admin. multipart/form-data satu field file. Maks. 3 MB, satu sheet, 5.000 baris. Kolom opsional yang tidak disertakan dipertahankan; sel kosong menghapus nilai.', query: object({ dry_run: { type: 'string', enum: ['true', 'false'], default: 'true' } }) },
  { method: 'POST', path: '/api/scan/match', summary: 'Cocokkan SN dalam kantor penugasan', roles: 'Teknisi. Result: found / not_found / multiple. SN dinormalisasi trim + uppercase.', body: object({ serial_number: string, schedule_id: entityId }, ['serial_number', 'schedule_id']), example: { serial_number: 'SN-001', schedule_id: '{{schedule_id}}' } },
  { method: 'POST', path: '/api/mapping-results', summary: 'Catat satu scan dan perbarui status/label aset', roles: 'Teknisi; jadwal aktif hari ini. Server menghitung result. Untuk multiple, asset_id opsional sebagai pilihan EQ; tanpa pilihan status aset tidak diubah. Hasil multiple tetap multiple.', body: object({ schedule_id: entityId, scanned_sn: string, asset_id: { ...entityId, nullable: true }, label_attached: { ...bool, default: false }, label_code: string }, ['schedule_id', 'scanned_sn']), example: { schedule_id: '{{schedule_id}}', scanned_sn: 'SN-001', label_attached: false } },
  { method: 'POST', path: '/api/assets/:id/not-found', summary: 'Tandai aset yang diharapkan tetapi tidak ditemukan fisik', roles: 'Teknisi pada jadwal aktif hari ini. Berbeda dari scan SN asing tanpa asset_id.', body: object({ schedule_id: entityId }, ['schedule_id']), example: { schedule_id: '{{schedule_id}}' } },
  { method: 'GET', path: '/api/schedules', summary: 'Daftar jadwal', roles: 'Admin; teknisi melihat jadwal sendiri dan jadwal tanpa penugasan pada area layanannya.', query: object({ ...page, office_id: entityId, assigned_to: entityId, area, status, date }) },
  { method: 'POST', path: '/api/schedules', summary: 'Buat jadwal', roles: 'Admin. Tanggal >= hari ini; kantor, area, teknisi harus cocok; jadwal aktif unik per kantor/tanggal.', body: object(schedule, ['office_id', 'area', 'scheduled_date']), example: { office_id: '{{office_id}}', area: 'grobogan', scheduled_date: '{{scheduled_date}}', assigned_to: '{{technician_id}}' } },
  { method: 'PATCH', path: '/api/schedules/:id', summary: 'Ubah jadwal atau tutup jadwal', roles: 'Admin. Selesai/dibatalkan bersifat final; identitas penugasan tidak dapat diganti setelah scan.', body: object(schedule), example: { status: 'selesai' } },
  { method: 'PATCH', path: '/api/schedules', summary: 'Ubah jadwal dengan id di body', roles: 'Admin. Alias PATCH /api/schedules/:id.', body: object({ id: entityId, ...schedule }, ['id']), example: { id: '{{schedule_id}}', status: 'selesai' } },
  { method: 'DELETE', path: '/api/schedules/:id', summary: 'Batalkan jadwal; pertahankan hasil scan', roles: 'Admin. Jadwal selesai tidak dapat dibatalkan.' },
  { method: 'DELETE', path: '/api/schedules', summary: 'Batalkan jadwal dengan query id', roles: 'Admin. Alias DELETE /api/schedules/:id.', query: object({ id: entityId }, ['id']) },
  { method: 'GET', path: '/api/dashboard/progress', summary: 'Progres status aset per kantor', roles: 'Admin. Progres = (sudah + tidak_ditemukan) / total. Status aset merupakan keadaan terkini, bukan snapshot per jadwal.', query: object({ ...page, area, office_id: entityId }) },
  { method: 'GET', path: '/api/dashboard/summary', summary:'Ringkasan total aset dan status mapping', roles:'Admin.' },
  { method: 'GET', path: '/api/reports/mapping', summary: 'Laporan satu baris per scan', roles: 'Admin. Filter tanggal memakai tanggal scan pada APP_TIMEZONE; REF/status/kondisi adalah keadaan aset terkini.', query: object(report) },
  { method: 'GET', path: '/api/reports/mapping/export', summary: 'Ekspor laporan XLSX', roles: 'Admin. Maksimal 10.000 scan.', query: object(report), binary: true },
  { method: 'GET', path: '/api/notifications/logs', summary: 'Log notifikasi dan status pengiriman', roles: 'Admin.', query: object(page) },
  { method: 'GET', path: '/api/cron/notify-schedule', summary: 'Kirim notifikasi jadwal hari ini', roles: 'Authorization: Bearer CRON_SECRET. Deduplikasi per tanggal/penerima/kantor/bagian.' },
  { method: 'GET', path: '/api/cron/notify-results', summary: 'Kirim ringkasan hasil jadwal hari ini', roles: 'Authorization: Bearer CRON_SECRET. Kegagalan dapat dicoba ulang sesudah 15 menit.' },
];
export function contractSchema(method: string, path: string): Schema {
  const contract = apiContracts.find(c => c.method === method && c.path === path);
  if (!contract) return {};
  const cron = path.startsWith('/api/cron/');
  const result: Schema = {
    summary: contract.summary, description: contract.roles,
    tags: [path.split('/')[2]||'health'], security: cron ? [{ cron: [] }] : ['/api/auth/login','/health'].includes(path) ? [] : [{ session: [] }],
    response: Object.fromEntries([400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503].map(code => [code, { description: 'Lihat error.code dan error.message.', $ref: '#/components/schemas/ApiError' }])),
  };
  if (contract.body) result.body = contract.body;
  if (contract.query) result.querystring = contract.query;
  if (path.includes(':id')) result.params = object({ id: entityId }, ['id']);
  if (!['GET', 'HEAD'].includes(method) && path !== '/api/auth/login') result.headers = object({ 'x-csrf-token': { type: 'string', description: 'csrf_token dari login atau /api/auth/me.' } }, ['x-csrf-token']);
  if (path === '/api/assets/import') {
    result.consumes = ['multipart/form-data'];
    result.body = object({ file: { type: 'string', format: 'binary' } }, ['file']);
  }
  const successCode = method === 'POST' && !['/api/auth/login', '/api/auth/logout', '/api/scan/match', '/api/assets/:id/not-found', '/api/assets/import'].includes(path) ? 201 : method === 'DELETE' && path.includes('offices') ? 204 : 200;
  result.response[successCode] = contract.binary
    ? { description: 'Excel XLSX', content: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { schema: { type: 'string', format: 'binary' } } } }
    : { description: 'Berhasil. data berisi objek atau daftar; meta pada daftar.', type: 'object', properties: { data: {}, meta: { type: 'object' } } };
  if (path === '/api/assets/import') result.response[201] = result.response[200];
  return result;
}
