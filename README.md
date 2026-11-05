# Backend Caps2Tone

Backend aplikasi mapping aset EQ–SN menggunakan **Node.js 22+, Fastify 5, TypeScript, PostgreSQL/Neon, dan SQL langsung melalui `pg`**. Tidak memakai Prisma atau Drizzle. Acuan fitur: [BACKEND-TASKS.md](BACKEND-TASKS.md); skema dan query mengikuti [queryDB.md](queryDB.md) melalui migrasi lanjutan.

Repo ini berdiri sendiri. Frontend Next.js tetap memakai backend ini melalui HTTP; `proxy.ts`, komponen React, dan penghapusan mock frontend dikerjakan di repo frontend. Keamanan API diterapkan lewat autentikasi global Fastify, pemeriksaan role di setiap handler, dan pembatasan kantor/jadwal teknisi.

Lingkungan kerja ini sudah terhubung ke Neon Singapore pada branch pengembangan, dengan migrasi dan akun seed yang sudah tersedia. Lihat [detail lingkungan Neon](docs/NEON.md). Password akun tersimpan pada variabel `SEED_ADMIN_PASSWORD`/`SEED_TECHNICIAN_PASSWORD` di `.env.local`; nilainya tidak dicetak ke log.

## Menjalankan

1. Install dependency: `npm ci`.
2. Untuk instalasi baru, salin `.env.example` menjadi `.env.local`. Jangan menimpa `.env.local` yang sudah tersedia.
3. Isi koneksi database dan konfigurasi berikut:

| Variabel | Nilai / ketentuan |
|---|---|
| `DATABASE_URL` | URL PostgreSQL aplikasi. Di Neon gunakan endpoint pooled dan `sslmode=verify-full`. |
| `DATABASE_URL_UNPOOLED` | URL endpoint direct untuk migrasi. |
| `AUTH_SECRET` | Acak, minimal 32 karakter; dipakai untuk HMAC token CSRF. |
| `CRON_SECRET` | Acak, minimal 32 karakter di produksi. |
| `SEED_ADMIN_USERNAME` | Contoh: `admin`. |
| `SEED_ADMIN_PASSWORD` | Password admin minimal 12 karakter. |
| `SEED_TECHNICIAN_PASSWORD` | Password awal akun teknisi pengembangan minimal 12 karakter. |
| `FRONTEND_ORIGINS` | Daftar origin dipisahkan koma; lokal: `http://localhost:3000,http://localhost:3001`. Sertakan origin backend untuk mencoba Swagger. |
| `NODE_ENV` | `development`, `test`, atau `production`; default `development`. |
| `HOST`, `PORT` | Default `0.0.0.0`, `3001`. |
| `APP_TIMEZONE` | Default `Asia/Jakarta`, mengikuti lokasi kantor Grobogan/Solo. |
| `COOKIE_SAME_SITE` | Default `lax`; gunakan `none` dengan HTTPS produksi jika frontend dan API berbeda situs. |
| `TECHNICIAN_CAN_EDIT_CONDITION` | Default `false`; `true` mengizinkan perubahan kondisi oleh teknisi pada penugasannya. |
| `REQUIRE_SCHEDULE_ASSIGNEE` | Default `false`; `true` mewajibkan penugasan saat membuat/mengubah jadwal. Jadwal tanpa teknisi tidak dapat dipindai. |
| `TELEGRAM_BOT_TOKEN` | Token bot server, diperlukan untuk pengiriman sungguhan. |
| `TELEGRAM_RECIPIENT_MODE` | `group` (default) atau `technician`. |
| `TELEGRAM_CHAT_ID` | ID grup untuk mode `group`. |
| `TELEGRAM_SUMMARY_MODE` | `daily` (default) atau `office`. |

Gunakan `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` untuk menghasilkan secret lokal. Semua secret hanya di `.env.local`/environment penyedia hosting, dan `.env.example` tetap tanpa nilai.

```powershell
npm run db:migrate
npm run db:seed
npm run dev
```

Swagger tersedia di `http://localhost:3001/docs`; kesehatan database di `/health`.

Indikator HTML untuk pengujian ping tersedia di **http://127.0.0.1:3001/monitor/** setelah server berjalan. Membuka alamat utama `/` juga mengarah ke monitor ini. Halaman menampilkan status server (`/ping`, tanpa query database), status database (`/health`), latensi, grafik 30 pemeriksaan terakhir, ping otomatis, batas waktu 3–15 detik, log, respons JSON, dan unduhan laporan. Tombol **Uji semua indikator** juga memeriksa dokumentasi dan proteksi sesi; respons 401 pada sesi berarti login diperlukan. Pengujian ini menggunakan GET dan tidak mengubah data aplikasi. Detail: [panduan monitor](docs/PING-MONITOR.md).

Seed bersifat idempotent: akun lama, password, role, dan area tidak ditimpa. Akun baru: admin sesuai konfigurasi, `teknisi` (dua area), `teknisi.grobogan`, `teknisi.solo`, dan `teknisi.gabungan`. Password akun baru menggunakan bcrypt (maksimal 72 byte UTF-8). Hash scrypt akun lama tetap dapat dipakai untuk login. Kantor contoh `KTR-GRB`/`KTR-SLO` hanya dibuat ketika bukan produksi. Dataset produksi diimpor dari file asli; data contoh berlabel DEMO dikelola terpisah di dev.

Alternatif PostgreSQL lokal: jalankan Docker Desktop, set `$env:LOCAL_DATABASE_PASSWORD` ke password lokal, lalu `docker compose up -d`. Gunakan database/user `caps2tone`, port `5432`, dan password yang sama pada URL database. Docker tidak dibutuhkan untuk pengujian otomatis.

## Perintah

| Perintah | Fungsi |
|---|---|
| `npm run dev` | Server pengembangan dengan watch. |
| `npm run build` / `npm start` | Kompilasi TypeScript / jalankan hasil kompilasi. |
| `npm run lint` | Type checking dan ESLint. |
| `npm test` | Integrasi Fastify + PostgreSQL tertanam PGlite; tidak memerlukan akun cloud. |
| `npm run check` | Lint, build, seluruh tes. |
| `npm run db:migrate` | Migrasi SQL transactional, advisory lock, dan checksum. |
| `npm run db:seed` | Seed akun tanpa menimpa akun lama. |
| `npm run db:demo` | Isi data DEMO permanen lewat API pada endpoint dev proyek ini; idempotent untuk hari yang sama. |
| `npm run smoke` | Uji HTTP terhadap database `.env.local`, menggunakan akun seed lalu logout. |
| `npm run smoke:write` | Uji HTTP baca/tulis ke Neon: kantor, impor aset, audit, jadwal, scan, laporan dan ekspor; seluruh fixture rollback dan diverifikasi tidak tersisa. |
| `npm run http:probe` | Hit HTTP ke server yang sudah berjalan pada 127.0.0.1:3001, seperti klien Postman; timeout 15 detik, laporan status/durasi, CRUD kantor uji dan cleanup. |
| `npm run docs:generate` | Perbarui OpenAPI dan koleksi Postman dari kontrak API. |
| `npm run assets:import -- file.xlsx admin --dry-run` | Validasi dataset asli lewat CLI; ganti `--dry-run` dengan `--commit` untuk menyimpan. |

Struktur utama: `src/routes/` untuk endpoint; `src/services/excel.ts` untuk impor/ekspor; `src/auth.ts` untuk sesi/role/CSRF; `migrations/` untuk skema; `tests/` untuk integrasi. Lihat [ERD](docs/ERD.md), [kontrak OpenAPI](docs/openapi.json), [koleksi Postman](docs/Caps2Tone.postman_collection.json), dan [status implementasi](docs/IMPLEMENTATION.md).

## Kontrak API dan integrasi frontend

Respons sukses: `{ "data": ... }`. Daftar memiliki `meta: { page, limit, total }`. Error: `{ "error": { "code", "message", "details"? } }`. ID dan foreign key memakai **integer positif** sesuai queryDB.md. UUID lama disimpan sebagai `legacy_id` untuk pelacakan. Field KONDISI bernama **`kondisi`** pada database/API; `condition` tetap diterima sebagai alias pada input aset dan tersedia pada respons aset. Header Excel tetap **Kondisi**.

Login menghasilkan cookie host-only `caps2tone_session` (`httpOnly`, kedaluwarsa 8 jam; `Secure` di produksi) dan `data.csrf_token`. Database hanya menyimpan SHA-256 token sesi. Logout menghapus sesi sehingga cookie lama tidak dapat dipakai lagi. Role dan `is_active` selalu dibaca dari database. Akun nonaktif ditolak saat login maupun penggunaan sesi. `users.areas` disinkronkan dua arah dengan tabel kompatibilitas `technician_areas`.

```typescript
const baseUrl = 'http://localhost:3001';
const response = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password }),
});
const { data, error } = await response.json();
if (!response.ok) throw new Error(error.message);
const csrfToken = data.csrf_token;

await fetch(`${baseUrl}/api/assets/${assetId}`, {
  method: 'PATCH', credentials: 'include',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
  body: JSON.stringify({ ref: 'REF-BARU', schedule_id: scheduleId }),
});
```

Semua mutasi setelah login memerlukan `X-CSRF-Token`. Pulihkan token setelah reload melalui `GET /api/auth/me`; simpan di memori frontend. Origin mutasi harus terdaftar. `credentials: 'include'` diperlukan pada setiap permintaan berbasis cookie. Guard halaman/redirect berdasarkan role tetap dipasang di frontend; backend mengembalikan 401/403, bukan redirect HTML.

Teknisi membaca `/api/schedules` dan `/api/technician/assets?schedule_id=...`. Jadwal hari ini yang belum ditugaskan tersedia bagi teknisi pada area terkait. `/api/technician/chassis` dan `/api/technician/chassis/:id/modules` menyediakan progres chassis/modul dengan query `schedule_id`. `/api/scan/match` menerima `serial_number` dan `schedule_id`. `/api/mapping-results` menerima `scanned_sn`, `schedule_id`, pilihan `asset_id` untuk hasil ganda, serta `label_attached`/`label_code`. Server menghitung ulang hasil pencocokan dan membatasi aset ke kantor penugasan. Scan hanya boleh pada jadwal aktif hari ini. Setiap scan sukses disimpan sebagai baris tersendiri; pemindaian ulang tetap tercatat. Pemasangan label sebelumnya tidak dihapus oleh scan tanpa label.

SN asing menghasilkan `not_found` dengan `asset_id=null`. Jika `asset_id` inventaris sekantor disertakan untuk SN asing, hasil scan tetap `not_found` dan aset tersebut ditandai `tidak_ditemukan`; label tidak dapat dipasang pada hasil ini. Untuk aset inventaris yang diketahui tetapi tidak ditemukan secara fisik, gunakan `POST /api/assets/:id/not-found` dengan `schedule_id`; endpoint ini memperbarui status inventaris, bukan membuat scan fiktif. Progres kantor memakai status terkini aset; laporan scan memakai tanggal scan pada `APP_TIMEZONE` dan mempertahankan setiap percobaan scan. Riwayat REF/STATUS/KONDISI disimpan otomatis oleh trigger dalam transaksi yang sama.

`DELETE /api/schedules/:id` membatalkan jadwal tanpa menghapus hasil scan. Alias sesuai dokumen: `PATCH /api/schedules` dengan `id` di body dan `DELETE /api/schedules?id=...`. Jadwal selesai/dibatalkan tidak dapat dibuka kembali. Kantor/tanggal/teknisi tidak dapat diganti setelah ada scan. Halaman `/admin/laporan` memakai `/api/reports/mapping` dan `/api/reports/mapping/export`.

## Impor/ekspor Excel

`POST /api/assets/import?dry_run=true` memakai `multipart/form-data` satu field `file`; pratinjau adalah default. Simpan dengan `dry_run=false`. Keduanya menjalankan validasi dan transaksi yang sama; pratinjau selalu rollback, termasuk riwayat perubahan.

Header wajib: **EQ, Jenis, Serial Number, Kode Kantor**. Header opsional: **SN Chassis, REF, Status, Kondisi, Kode Aset**. `Jenis` berisi `Chassis` atau `Modul`. Kode kantor harus sudah ada. SN Chassis harus cocok tepat satu chassis di kantor yang sama; baris chassis diproses sebelum modul sehingga urutan file tidak membatasi.

EQ adalah kunci upsert. SN dinormalisasi trim + uppercase dan sengaja tidak unik. Header opsional yang tidak ada mempertahankan nilai lama; header yang disertakan dengan sel kosong mengosongkan nilai tersebut. Formula/objek sel ditolak. Semua kesalahan baris dikembalikan beserta nomor baris; jika ada kesalahan, seluruh impor rollback. Maksimal XLSX 3 MB, satu sheet, 5.000 baris, 9 kolom, dan isi arsip 32 MB. Ekspor mengikuti filter, maksimal 10.000 baris; pagination hanya berlaku pada respons JSON.

## Telegram dan deployment

Mode grup memakai `TELEGRAM_CHAT_ID`; mode teknisi memakai `users.telegram_chat_id`. Isi kolom tersebut melalui proses administrasi database dengan query berparameter. Bot harus dapat mengirim pesan ke penerima. Endpoint yang belum memiliki konfigurasi mengembalikan 503; tidak ada pengiriman palsu.

Cron memakai `Authorization: Bearer <CRON_SECRET>`. Konfigurasi `vercel.json`: jadwal pagi `00:00 UTC` (07:00 WIB) dan hasil sore `11:00 UTC` (18:00 WIB), masing-masing sekali sehari. Jadwal cron selalu UTC; sesuaikan jika mengganti `APP_TIMEZONE`. Batas paket dan ketepatan eksekusi mengikuti [dokumentasi Vercel Cron](https://vercel.com/docs/cron-jobs/usage-and-pricing).

Pengiriman dicatat di `notification_logs`. Klaim unik mencegah pengiriman ulang oleh pemanggilan bersamaan/berulang. Kegagalan dapat dicoba kembali setelah 15 menit. Jika proses berhenti tepat setelah Telegram menerima pesan tetapi sebelum database mencatat sukses, retry dapat mengirim duplikat; Telegram tidak menyediakan kunci idempotensi. Ringkasan pagi/sore memakai jadwal pada tanggal lokal hari ini, termasuk semua scan pada jadwal tersebut.

Untuk Vercel, gunakan entrypoint fungsi `api/index.ts` dan rewrite yang sudah disediakan. Set root proyek ke folder ini dan environment produksi (`NODE_ENV=production`, origin HTTPS, secret). Gunakan koneksi pooled untuk aplikasi dan direct untuk migrasi. Pool dipasang ke lifecycle Vercel dengan `attachDatabasePool`. Jalankan migrasi pada branch preview sebelum produksi; jangan menjalankan seed pengembangan otomatis saat build. Sesudah deploy, uji `/health`, login, akses role, dan dua cron dengan secret yang benar. Deploy sungguhan memerlukan akun/proyek Vercel yang dituju.

Pengembangan tim memakai branch `feature/<nama-fitur>`, PR, dan minimal satu reviewer lain sesuai dokumen tugas. Penggantian mock, uji teknisi/SUS, data asli, dan review anggota lain membutuhkan repo/frontend/tim terkait.

Referensi implementasi: [Fastify testing](https://fastify.dev/docs/latest/Guides/Testing/), [transaksi node-postgres](https://node-postgres.com/features/transactions), [Neon pooling](https://neon.com/docs/connect/connection-pooling), [Fastify di Vercel](https://vercel.com/kb/guide/ship-a-fastify-app-on-vercel).

## Penyesuaian queryDB dan contoh data permanen

Migrasi `002_align_querydb.sql` mempertahankan data dan referensi lama sambil mengubah ID menjadi integer, menambahkan delapan enum, `users.areas/is_active/updated_at`, timestamp kantor/jadwal, kolom `kondisi`, dan audit `app.user_id`. Migrasi `003_notification_log_defaults.sql` mendukung INSERT log administratif tanpa dedupe_key eksplisit. Jangan mengubah file migrasi yang sudah diterapkan.

Admin dapat membuat akun melalui `POST /api/users`, mengatur area/chat ID/status aktif melalui `PATCH /api/users/:id`, dan membuat aset langsung melalui `POST /api/assets`. Password dikirim sebagai `password`, bukan `password_hash`; hash dibuat server. Penonaktifan atau perubahan hak akun mencabut sesinya.

Data DEMO telah disimpan permanen di dev atas persetujuan pengguna: dua kantor berawalan `DEMO-`, enam aset, dua jadwal, enam scan dengan ketiga hasil, dan riwayat perubahan. Log `demo_verification` diberi `success=false`, `sent_at=null`, dan `no_message_sent=true`; bukan pengiriman Telegram nyata. ID/SN aktual tersedia di [demo-data.json](docs/demo-data.json). Eksekusi ulang pada hari yang sama mempertahankan record yang sudah ada; pada hari berikutnya dapat membuat jadwal/scan demo untuk hari baru.

Untuk mencoba Postman, impor koleksi terbaru, isi variabel `password` dari konfigurasi seed lokal, jalankan login, kemudian GET aset/jadwal/laporan. ID DEMO sudah terisi pada variabel koleksi. Respons POST kantor/aset/pengguna/jadwal otomatis menyimpan ID untuk request berikutnya. Contoh input JSON dan perbedaan skema dijelaskan di [panduan queryDB](docs/QUERYDB-IMPLEMENTATION.md).
