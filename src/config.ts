import { config as dotenv } from 'dotenv';
import { z } from 'zod';

dotenv({ path: '.env.local', quiet: true });
const blankToUndefined = (value: unknown) => value === '' ? undefined : value;
const optionalText = z.preprocess(blankToUndefined, z.string().optional());
const flag = (fallback: boolean) => z.preprocess(blankToUndefined,
  z.enum(['true', 'false']).default(String(fallback) as 'true' | 'false')).transform(v => v === 'true');
const schema = z.object({
  NODE_ENV: z.preprocess(blankToUndefined, z.enum(['development', 'test', 'production']).default('development')),
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(32),
  CRON_SECRET: optionalText,
  TELEGRAM_BOT_TOKEN: optionalText,
  TELEGRAM_CHAT_ID: optionalText,
  TELEGRAM_RECIPIENT_MODE: z.preprocess(blankToUndefined, z.enum(['group', 'technician']).default('group')),
  TELEGRAM_SUMMARY_MODE: z.preprocess(blankToUndefined, z.enum(['daily', 'office']).default('daily')),
  FRONTEND_ORIGINS: z.preprocess(blankToUndefined, z.string().default('http://localhost:3000,http://localhost:3001')),
  APP_TIMEZONE: z.preprocess(blankToUndefined, z.string().default('Asia/Jakarta')),
  COOKIE_SAME_SITE: z.preprocess(blankToUndefined, z.enum(['lax', 'none', 'strict']).default('lax')),
  TECHNICIAN_CAN_EDIT_CONDITION: flag(false),
  REQUIRE_SCHEDULE_ASSIGNEE: flag(false),
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65535).default(3001)),
  HOST: z.preprocess(blankToUndefined, z.string().default('0.0.0.0')),
});
export type Config = z.infer<typeof schema>;
export function loadConfig(env = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`Konfigurasi belum valid: ${result.error.issues.map(i => i.path.join('.')).join(', ')}`);
  const c = result.data;
  new Intl.DateTimeFormat('en', { timeZone: c.APP_TIMEZONE });
  const origins = c.FRONTEND_ORIGINS.split(',').map(v => v.trim());
  if (origins.some(v => new URL(v).origin !== v)) throw new Error('FRONTEND_ORIGINS harus berupa origin URL tanpa path.');
  if (c.NODE_ENV === 'production' && (origins.some(v => !v.startsWith('https://')) || !c.CRON_SECRET || c.CRON_SECRET.length < 32)) {
    throw new Error('Produksi memerlukan origin HTTPS dan CRON_SECRET minimal 32 karakter.');
  }
  if (c.COOKIE_SAME_SITE === 'none' && c.NODE_ENV !== 'production') throw new Error('SameSite none memerlukan HTTPS produksi.');
  return c;
}
export function today(timeZone: string, at = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (key: string) => parts.find(p => p.type === key)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
