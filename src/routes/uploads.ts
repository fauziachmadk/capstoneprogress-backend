import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../db.js';
import type { Config } from '../config.js';
import { requireRole } from '../auth.js';
import { requireSchedule } from '../access.js';
import { ApiError } from '../errors.js';
import { id } from '../validation.js';

const folder = 'caps2tone/validasi';
const allowedFormats = 'jpg,jpeg,png,webp';

export function cloudinaryConfig(config: Config) {
  const { CLOUDINARY_CLOUD_NAME: cloudName, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: apiSecret } = config;
  if (!cloudName || !apiKey || !apiSecret) throw new ApiError(503, 'CLOUDINARY_NOT_CONFIGURED', 'Cloudinary belum dikonfigurasi.');
  return { cloudName, apiKey, apiSecret };
}

// Tanda tangan unggahan Cloudinary: SHA-1 dari parameter (urut abjad, "k=v" digabung "&") + API secret.
export function signUpload(params: Record<string, string | number>, apiSecret: string) {
  const toSign = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&');
  return createHash('sha1').update(toSign + apiSecret).digest('hex');
}

// Hanya URL gambar dari cloud milik proyek ini yang diterima, supaya kolom foto tidak bisa diisi tautan sembarang.
export function assertPhotoUrl(config: Config, value: string) {
  const { cloudName } = cloudinaryConfig(config);
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(422, 'PHOTO_URL_INVALID', 'URL foto tidak valid.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'res.cloudinary.com' || url.port || url.username || url.password
    || !url.pathname.startsWith(`/${cloudName}/image/upload/`)) {
    throw new ApiError(422, 'PHOTO_URL_INVALID', 'Foto harus diunggah ke Cloudinary proyek ini.');
  }
  return url.href;
}

export function registerUploads(app: FastifyInstance, db: Database, config: Config) {
  // Teknisi meminta tanda tangan, lalu mengunggah foto langsung ke Cloudinary (file tidak lewat server ini).
  // Batas ukuran 5 MB dijaga frontend; Cloudinary menolak format di luar allowed_formats.
  app.post('/api/uploads/sign', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async request => {
    const user = requireRole(request, 'teknisi');
    const input = z.object({ schedule_id: id }).strict().parse(request.body);
    const cloudinary = cloudinaryConfig(config);
    await requireSchedule(db, user, input.schedule_id, config.APP_TIMEZONE, true);
    const params = { allowed_formats: allowedFormats, folder, timestamp: Math.floor(Date.now() / 1000) };
    return { data: { upload_url: `https://api.cloudinary.com/v1_1/${cloudinary.cloudName}/image/upload`, cloud_name: cloudinary.cloudName,
      api_key: cloudinary.apiKey, params, signature: signUpload(params, cloudinary.apiSecret) } };
  });
}
