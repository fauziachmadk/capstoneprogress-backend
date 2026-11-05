import { config } from 'dotenv';
import { z } from 'zod';
import { createDatabase } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
config({ path: '.env.local', quiet: true });
const env = z.object({ DATABASE_URL: z.string().min(1), SEED_ADMIN_USERNAME: z.string().trim().min(1).default('admin'),
  SEED_ADMIN_PASSWORD: z.string().min(12).max(1024), SEED_TECHNICIAN_PASSWORD: z.string().min(12).max(1024) }).parse(process.env);
const db = createDatabase(env.DATABASE_URL);
try {
  const adminHash = await hashPassword(env.SEED_ADMIN_PASSWORD); const technicianHash = await hashPassword(env.SEED_TECHNICIAN_PASSWORD);
  await db.transaction(async tx => {
    const seeds = [
      { username: env.SEED_ADMIN_USERNAME.toLowerCase(), name: 'Administrator', role: 'admin', areas: [] },
      { username: 'teknisi', name: 'Teknisi Contoh', role: 'teknisi', areas: ['grobogan', 'solo'] },
      { username: 'teknisi.grobogan', name: 'Teknisi Grobogan', role: 'teknisi', areas: ['grobogan'] },
      { username: 'teknisi.solo', name: 'Teknisi Solo', role: 'teknisi', areas: ['solo'] },
      { username: 'teknisi.gabungan', name: 'Teknisi Dua Area', role: 'teknisi', areas: ['grobogan', 'solo'] },
    ];
    for (const user of seeds) {
      const inserted = (await tx.query(`INSERT INTO users(name,username,password_hash,role,areas) VALUES($1,$2,$3,$4,$5::text[]::area_type[])
        ON CONFLICT DO NOTHING RETURNING id`, [user.name, user.username, user.role === 'admin' ? adminHash : technicianHash, user.role,user.areas])).rows[0];
      if (!inserted) continue; // Do not overwrite an existing user's credentials or privileges.
    }
    if (process.env.NODE_ENV !== 'production') {
      await tx.query(`INSERT INTO offices(code,name,address,area) VALUES
        ('KTR-GRB','Kantor Grobogan','Grobogan','grobogan'),('KTR-SLO','Kantor Solo','Solo','solo') ON CONFLICT(code) DO NOTHING`);
    }
  });
  console.log('Seed selesai; akun lama tidak diubah. Password tidak ditampilkan.');
} finally { await db.close(); }
