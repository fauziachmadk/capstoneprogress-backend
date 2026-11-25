import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import type { Config } from '../config.js';
import { today } from '../config.js';
import { secureEqual, requireRole } from '../auth.js';
import { ApiError } from '../errors.js';
import { z } from 'zod';
import { date, pagination } from '../validation.js';
export type TelegramSender = (chatId: string, text: string) => Promise<void>;
const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
/** YYYY-MM-DD menjadi "5 Nov 2026", sama dengan formatDay di frontend. */
export function formatDay(day: string) {
  const [year, month, dayOfMonth] = day.split('-').map(Number);
  return `${dayOfMonth} ${monthNames[month - 1]} ${year}`;
}
export type OfficeLoad = { office_id: number; office_name: string; total: number; remaining: number };
export function scheduleMessage(day: string, name: string, offices: OfficeLoad[]) {
  const lines = offices.map((o, i) => `${i + 1}. ${o.office_name}: ${o.remaining} perangkat belum termapping (dari ${o.total})`).join('\n');
  const remaining = offices.reduce((n, o) => n + o.remaining, 0);
  return `Jadwal mapping ${formatDay(day)}\nHalo ${name}, kamu bertugas di:\n${lines}\n\nTotal yang harus dimapping: ${remaining} perangkat.\nSelamat bekerja.`;
}
export function createTelegramSender(token: string): TelegramSender {
  return async (chatId, text) => {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }), signal: AbortSignal.timeout(10000),
      });
      const body = await response.json() as { ok?: boolean };
      if (!response.ok || !body.ok) throw new Error('Telegram menolak pesan.');
    } catch { throw new ApiError(502, 'TELEGRAM_FAILED', 'Pengiriman Telegram gagal.'); }
  };
}
export function registerNotifications(app: FastifyInstance, db: Database, config: Config, injectedSender?: TelegramSender) {
  app.get('/api/notifications/logs', async request => {
    requireRole(request, 'admin'); const q = z.object(pagination).strict().parse(request.query);
    const total = Number((await db.query('SELECT count(*) AS total FROM notification_logs')).rows[0].total);
    const rows = (await db.query('SELECT id,type,payload,sent_at,success,attempted_at FROM notification_logs ORDER BY attempted_at DESC,id LIMIT $1 OFFSET $2', [q.limit, (q.page - 1) * q.limit])).rows;
    return { data: rows, meta: { ...q, total } };
  });
  // Rencana kirim manual: satu pesan per teknisi untuk satu tanggal, memuat semua kantornya.
  // "Harus dimapping" = aset berstatus belum. telegram_chat_id hanya dipakai di server, tidak pernah dikembalikan.
  async function schedulePlan(day: string) {
    const rows = (await db.query<{ user_id: number; name: string; telegram_chat_id: string | null; offices: OfficeLoad[] }>(
      `SELECT u.id AS user_id,u.name,u.telegram_chat_id,
        json_agg(json_build_object('office_id',o.id,'office_name',o.name,'total',a.total,'remaining',a.remaining) ORDER BY o.name,o.id) AS offices
        FROM mapping_schedules s JOIN users u ON u.id=s.assigned_to JOIN offices o ON o.id=s.office_id
        CROSS JOIN LATERAL (SELECT count(*)::int AS total,count(*) FILTER(WHERE mapping_status='belum')::int AS remaining FROM assets WHERE office_id=o.id) a
        WHERE s.scheduled_date=$1::date AND s.status IN ('terjadwal','berjalan') AND u.approval_status='aktif'
        GROUP BY u.id ORDER BY u.name,u.id`, [day])).rows;
    // Tanpa teknisi, atau teknisinya sudah tidak aktif: tidak terkirim ke siapa pun.
    const unassigned = (await db.query<{ office_id: number; office_name: string }>(
      `SELECT o.id AS office_id,o.name AS office_name FROM mapping_schedules s JOIN offices o ON o.id=s.office_id
        LEFT JOIN users u ON u.id=s.assigned_to
        WHERE s.scheduled_date=$1::date AND s.status IN ('terjadwal','berjalan') AND (u.id IS NULL OR u.approval_status<>'aktif')
        ORDER BY o.name,o.id`, [day])).rows;
    return { recipients: rows, unassigned };
  }
  app.get('/api/schedules/notify-preview', async request => {
    requireRole(request, 'admin'); const q = z.object({ date }).strict().parse(request.query);
    const plan = await schedulePlan(q.date);
    const last = new Map<number, { success: boolean; at: string }>();
    for (const log of (await db.query(`SELECT (payload->>'user_id')::int AS user_id,success,coalesce(sent_at,attempted_at) AS at FROM notification_logs
      WHERE type='jadwal_manual' AND payload->>'date'=$1 ORDER BY attempted_at DESC,id DESC`, [q.date])).rows) {
      if (!last.has(log.user_id)) last.set(log.user_id, { success: log.success, at: log.at });
    }
    const recipients = plan.recipients.map(r => ({ user_id: r.user_id, name: r.name, linked: Boolean(r.telegram_chat_id), offices: r.offices,
      total_remaining: r.offices.reduce((n, o) => n + o.remaining, 0), message: scheduleMessage(q.date, r.name, r.offices), last_sent: last.get(r.user_id) ?? null }));
    const sendable = recipients.filter(r => r.linked).length;
    return { data: { date: q.date, recipients, unassigned: plan.unassigned, sendable, skipped: recipients.length - sendable } };
  });
  app.post('/api/schedules/notify', async request => {
    const admin = requireRole(request, 'admin'); const input = z.object({ date }).strict().parse(request.body);
    if (!injectedSender && !config.TELEGRAM_BOT_TOKEN) throw new ApiError(503, 'TELEGRAM_NOT_CONFIGURED', 'Telegram belum dikonfigurasi.');
    const sender = injectedSender ?? createTelegramSender(config.TELEGRAM_BOT_TOKEN!);
    const results: { user_id: number; name: string; status: 'sent' | 'skipped' | 'failed' }[] = [];
    for (const r of (await schedulePlan(input.date)).recipients) {
      if (!r.telegram_chat_id) { results.push({ user_id: r.user_id, name: r.name, status: 'skipped' }); continue; }
      // Payload log tidak memuat chat ID, token, atau isi pesan.
      const payload = { date: input.date, user_id: r.user_id, technician: r.name, office_ids: r.offices.map(o => o.office_id),
        total_remaining: r.offices.reduce((n, o) => n + o.remaining, 0), sent_by: admin.id };
      const log = (await db.query("INSERT INTO notification_logs(type,payload,sent_at,success) VALUES('jadwal_manual',$1::jsonb,NULL,false) RETURNING id", [JSON.stringify(payload)])).rows[0];
      try {
        await sender(r.telegram_chat_id, scheduleMessage(input.date, r.name, r.offices));
        await db.query('UPDATE notification_logs SET success=true,sent_at=now() WHERE id=$1', [log.id]);
        results.push({ user_id: r.user_id, name: r.name, status: 'sent' });
      } catch {
        await db.query("UPDATE notification_logs SET payload=payload || '{\"error\":\"Pengiriman gagal\"}'::jsonb WHERE id=$1", [log.id]);
        results.push({ user_id: r.user_id, name: r.name, status: 'failed' });
      }
    }
    const count = (status: string) => results.filter(r => r.status === status).length;
    return { data: { date: input.date, sent: count('sent'), skipped: count('skipped'), failed: count('failed'), results } };
  });
  for (const type of ['schedule', 'results'] as const) {
    app.get(`/api/cron/notify-${type}`, { schema: { security: [{ cron: [] }] } }, async request => {
      if (!config.CRON_SECRET || !secureEqual(String(request.headers.authorization ?? ''), `Bearer ${config.CRON_SECRET}`)) throw new ApiError(401, 'INVALID_CRON_SECRET', 'Akses cron ditolak.');
      if (!injectedSender && !config.TELEGRAM_BOT_TOKEN) throw new ApiError(503, 'TELEGRAM_NOT_CONFIGURED', 'Telegram belum dikonfigurasi.');
      if (config.TELEGRAM_RECIPIENT_MODE === 'group' && !config.TELEGRAM_CHAT_ID) throw new ApiError(503, 'TELEGRAM_NOT_CONFIGURED', 'Grup Telegram belum dikonfigurasi.');
      const day = today(config.APP_TIMEZONE);
      const resultDay = type === 'results' ? ' AND (r.scanned_at AT TIME ZONE $2)::date=$1::date' : '';
      const dayFilter = type === 'results' ? `(s.scheduled_date=$1::date OR EXISTS(SELECT 1 FROM mapping_results rr WHERE rr.schedule_id=s.id AND (rr.scanned_at AT TIME ZONE $2)::date=$1::date))`
        : "s.scheduled_date=$1::date AND s.status <> 'dibatalkan'";
      const rows = (await db.query(`SELECT s.id,s.office_id,s.assigned_to,s.scheduled_date::text,s.status,
        o.name AS office_name,u.name AS technician_name,u.telegram_chat_id,
        count(r.id)::int AS scans,count(r.id) FILTER(WHERE r.result='found')::int AS found,
        count(r.id) FILTER(WHERE r.result='not_found')::int AS not_found,
        count(r.id) FILTER(WHERE r.result='multiple')::int AS multiple,
        count(DISTINCT r.asset_id)::int AS mapped_assets
        FROM mapping_schedules s JOIN offices o ON o.id=s.office_id
        LEFT JOIN mapping_results r ON r.schedule_id=s.id${resultDay}
        LEFT JOIN users u ON u.id=${type==='results' && config.TELEGRAM_RECIPIENT_MODE==='technician' ? 'coalesce(r.scanned_by,s.assigned_to)' : 's.assigned_to'}
        WHERE ${dayFilter}
        GROUP BY s.id,o.name,u.id ORDER BY o.name,s.id,u.id`, type==='results' ? [day,config.APP_TIMEZONE] : [day])).rows;
      const tasks = new Map<string, { chatId: string; lines: string[]; officeKey: string }>();
      const missing: string[] = [];
      for (const row of rows) {
        const chatId = config.TELEGRAM_RECIPIENT_MODE === 'group' ? config.TELEGRAM_CHAT_ID : row.telegram_chat_id;
        if (!chatId) { missing.push(row.id); continue; }
        const officeKey = config.TELEGRAM_SUMMARY_MODE === 'office' ? row.office_id : 'daily';
        const key = `${chatId}:${officeKey}`;
        if (!tasks.has(key)) tasks.set(key, { chatId, officeKey, lines: [] });
        tasks.get(key)!.lines.push(type === 'schedule'
          ? `${row.office_name} — ${row.technician_name ?? 'Belum ditugaskan'} (${row.status})`
          : `${row.office_name}: ${row.scans} scan, ${row.mapped_assets} aset; cocok ${row.found}, tidak cocok ${row.not_found}, ganda ${row.multiple}.`);
      }
      if (missing.length) throw new ApiError(503, 'RECIPIENT_MISSING', 'Ada jadwal tanpa penerima Telegram. Lengkapi penugasan/chat ID.', { schedule_ids: missing });
      const sender = injectedSender ?? createTelegramSender(config.TELEGRAM_BOT_TOKEN!);
      let sent = 0; let skipped = 0; let failed = 0;
      for (const task of tasks.values()) {
        const heading = `${type === 'schedule' ? 'Jadwal mapping' : 'Ringkasan hasil mapping'} ${day}\n`;
        // Telegram messages are limited to 4096 characters; partition at complete office lines.
        const chunks: string[] = []; let message = heading;
        for (const line of task.lines) {
          if (message.length + line.length + 1 > 3500) { chunks.push(message); message = heading; }
          message += `${line}\n`;
        }
        chunks.push(message);
        for (let part = 0; part < chunks.length; part++) {
          const text = chunks[part];
          const key = `${type}:${day}:${task.chatId}:${task.officeKey}:${part}`;
          const payload = { chat_id: task.chatId, text, date: day };
          const claimed = (await db.query(`INSERT INTO notification_logs(type,dedupe_key,payload,sent_at) VALUES($1,$2,$3::jsonb,NULL)
            ON CONFLICT(dedupe_key) DO UPDATE SET attempted_at=now(),payload=excluded.payload,sent_at=NULL
            WHERE notification_logs.success=false AND notification_logs.attempted_at < now()-interval '15 minutes' RETURNING id`, [type, key, JSON.stringify(payload)])).rows[0];
          if (!claimed) { skipped++; continue; }
          try {
            await sender(task.chatId, text);
            await db.query('UPDATE notification_logs SET success=true,sent_at=now() WHERE id=$1', [claimed.id]);
            sent++;
          } catch {
            await db.query("UPDATE notification_logs SET payload=payload || '{\"error\":\"Pengiriman gagal\"}'::jsonb WHERE id=$1", [claimed.id]);
            failed++;
          }
        }
      }
      if (failed) throw new ApiError(502, 'NOTIFICATION_FAILED', 'Sebagian notifikasi gagal; dapat dicoba lagi setelah 15 menit.', { sent, skipped, failed });
      return { data: { date: day, sent, skipped, failed } };
    });
  }
}
