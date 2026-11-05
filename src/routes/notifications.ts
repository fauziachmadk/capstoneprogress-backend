import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import type { Config } from '../config.js';
import { today } from '../config.js';
import { secureEqual, requireRole } from '../auth.js';
import { ApiError } from '../errors.js';
import { z } from 'zod';
import { pagination } from '../validation.js';
export type TelegramSender = (chatId: string, text: string) => Promise<void>;
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
