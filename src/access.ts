import type { Database } from './db.js';
import type { User } from './auth.js';
import { ApiError, assertExists } from './errors.js';
import { today } from './config.js';
export async function requireSchedule(db: Database, user: User, scheduleId: number, timeZone: string, writable = false) {
  const schedule = assertExists((await db.query(`SELECT id,office_id,area,assigned_to,status,scheduled_date::text
    FROM mapping_schedules WHERE id=$1${writable ? ' FOR UPDATE' : ''}`, [scheduleId])).rows[0], 'Jadwal tidak ditemukan.');
  if (user.role === 'teknisi') {
    const served = (await db.query('SELECT 1 FROM technician_areas WHERE user_id=$1 AND area=$2', [user.id, schedule.area])).rows.length;
    if ((schedule.assigned_to !== null && schedule.assigned_to !== user.id) || !served) throw new ApiError(403, 'SCHEDULE_FORBIDDEN', 'Jadwal bukan penugasan atau area layanan Anda.');
  }
  if (writable && (!['terjadwal', 'berjalan'].includes(schedule.status) || schedule.scheduled_date !== today(timeZone))) {
    throw new ApiError(409, 'SCHEDULE_INACTIVE', 'Scan hanya untuk jadwal aktif hari ini.');
  }
  return schedule;
}
