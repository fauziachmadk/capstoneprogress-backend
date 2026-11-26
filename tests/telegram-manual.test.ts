import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';

const day = '2099-11-05';

async function setup(sender: (chatId: string, text: string) => Promise<void>) {
  const f = await fixture({}, sender);
  const admin = await f.login();
  const charlie = (await f.db.query("INSERT INTO offices(code,name,area) VALUES('KTR-C','Charlie','grobogan') RETURNING id")).rows[0].id as number;
  // Grobogan: 2 aset (1 sudah, 1 belum); Solo: 1 aset belum.
  await f.db.query("INSERT INTO assets(eq,kind,serial_number,office_id,mapping_status) VALUES('EQ-M1','module','SN-M1',$1,'sudah')", [f.office]);
  const post = (payload: object) => f.app.inject({ method: 'POST', url: '/api/schedules', headers: admin, payload });
  assert.equal((await post({ office_id: f.office, area: 'grobogan', scheduled_date: day, assigned_to: f.tech })).statusCode, 201);
  assert.equal((await post({ office_id: f.otherOffice, area: 'solo', scheduled_date: day, assigned_to: f.other })).statusCode, 201);
  assert.equal((await post({ office_id: charlie, area: 'grobogan', scheduled_date: day })).statusCode, 201);
  return { f, admin, charlie };
}
const expected = 'Jadwal mapping 5 Nov 2099\nHalo Teknisi, kamu bertugas di:\n1. Grobogan: 1 perangkat belum termapping (dari 2)\n\nTotal yang harus dimapping: 1 perangkat.\nSelamat bekerja.';

test('pratinjau kirim Telegram: penerima per teknisi, terhubung, belum ditugaskan, tanpa chat ID', async t => {
  const { f, admin, charlie } = await setup(async () => {}); t.after(() => f.close());
  const res = await f.app.inject({ url: `/api/schedules/notify-preview?date=${day}`, headers: admin });
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json().data;
  assert.deepEqual(data.recipients.map((r: any) => [r.name, r.linked]), [['Lain', false], ['Teknisi', true]]);
  const teknisi = data.recipients[1];
  assert.deepEqual(teknisi.offices, [{ office_id: f.office, office_name: 'Grobogan', total: 2, remaining: 1 }]);
  assert.equal(teknisi.total_remaining, 1); assert.equal(teknisi.message, expected); assert.equal(teknisi.last_sent, null);
  assert.deepEqual(data.unassigned, [{ office_id: charlie, office_name: 'Charlie' }]);
  assert.equal(data.sendable, 1); assert.equal(data.skipped, 1);
  assert.equal(res.body.includes('12345'), false);

  // Teknisi yang dinonaktifkan tidak menerima pesan; kantornya dilaporkan sebagai belum ditugaskan.
  await f.db.query("UPDATE users SET is_active=false WHERE id=$1", [f.other]);
  const after = (await f.app.inject({ url: `/api/schedules/notify-preview?date=${day}`, headers: admin })).json().data;
  assert.deepEqual(after.recipients.map((r: any) => r.name), ['Teknisi']);
  assert.deepEqual(after.unassigned.map((u: any) => u.office_name), ['Charlie', 'Solo']);

  const empty = (await f.app.inject({ url: '/api/schedules/notify-preview?date=2098-01-01', headers: admin })).json().data;
  assert.deepEqual([empty.recipients, empty.unassigned, empty.sendable], [[], [], 0]);
});

test('kirim manual: terkirim ke teknisi terhubung, dilewati yang belum, tercatat tanpa data sensitif', async t => {
  const sent: [string, string][] = [];
  const { f, admin } = await setup(async (chatId, text) => { sent.push([chatId, text]); }); t.after(() => f.close());
  const res = await f.app.inject({ method: 'POST', url: '/api/schedules/notify', headers: admin, payload: { date: day } });
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json().data;
  assert.deepEqual([data.sent, data.skipped, data.failed], [1, 1, 0]);
  assert.deepEqual(data.results.map((r: any) => [r.name, r.status]), [['Lain', 'skipped'], ['Teknisi', 'sent']]);
  assert.deepEqual(sent, [['12345', expected]]);

  const logs = (await f.db.query("SELECT payload,success,sent_at FROM notification_logs WHERE type='jadwal_manual'")).rows;
  assert.equal(logs.length, 1); assert.equal(logs[0].success, true); assert.ok(logs[0].sent_at);
  assert.deepEqual(logs[0].payload, { date: day, user_id: f.tech, technician: 'Teknisi', office_ids: [f.office], total_remaining: 1, sent_by: f.admin });
  assert.equal(JSON.stringify(logs[0].payload).includes('12345'), false);

  const preview = (await f.app.inject({ url: `/api/schedules/notify-preview?date=${day}`, headers: admin })).json().data;
  assert.equal(preview.recipients[1].last_sent.success, true); assert.equal(preview.recipients[0].last_sent, null);
});

test('kirim manual: kegagalan satu teknisi dilaporkan dan dicatat, yang lain tetap diproses', async t => {
  const sent: string[] = [];
  const { f, admin } = await setup(async chatId => { if (chatId === '12345') throw new Error('Telegram menolak'); sent.push(chatId); }); t.after(() => f.close());
  await f.db.query("UPDATE users SET telegram_chat_id='67890' WHERE id=$1", [f.other]);
  const data = (await f.app.inject({ method: 'POST', url: '/api/schedules/notify', headers: admin, payload: { date: day } })).json().data;
  assert.deepEqual([data.sent, data.skipped, data.failed], [1, 0, 1]);
  assert.deepEqual(data.results.map((r: any) => [r.name, r.status]), [['Lain', 'sent'], ['Teknisi', 'failed']]);
  assert.deepEqual(sent, ['67890']);
  const failed = (await f.db.query("SELECT payload,success FROM notification_logs WHERE type='jadwal_manual' AND success=false")).rows;
  assert.equal(failed.length, 1); assert.equal(failed[0].payload.error, 'Pengiriman gagal'); assert.equal(failed[0].payload.user_id, f.tech);
  const preview = (await f.app.inject({ url: `/api/schedules/notify-preview?date=${day}`, headers: admin })).json().data;
  assert.equal(preview.recipients.find((r: any) => r.name === 'Teknisi').last_sent.success, false);
});

test('kirim manual: hak akses, validasi tanggal, dan bot belum dikonfigurasi', async t => {
  const { f, admin } = await setup(async () => {}); t.after(() => f.close());
  const tech = await f.login('teknisi');
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/schedules/notify', headers: tech, payload: { date: day } })).statusCode, 403);
  assert.equal((await f.app.inject({ url: `/api/schedules/notify-preview?date=${day}`, headers: tech })).statusCode, 403);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/schedules/notify', headers: admin, payload: { date: 'kemarin' } })).statusCode, 422);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/schedules/notify', headers: admin, payload: { date: day, user_id: 1 } })).statusCode, 422);
  assert.equal((await f.app.inject({ url: '/api/schedules/notify-preview', headers: admin })).statusCode, 422);

  const plain = await fixture(); t.after(() => plain.close());
  const res = await plain.app.inject({ method: 'POST', url: '/api/schedules/notify', headers: await plain.login(), payload: { date: day } });
  assert.equal(res.statusCode, 503); assert.equal(res.json().error.code, 'TELEGRAM_NOT_CONFIGURED');
});
