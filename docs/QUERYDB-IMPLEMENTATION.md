# Implementasi queryDB.md

Skema `main` dan `dev-backend-fastify` sudah mengikuti struktur bisnis `queryDB.md`. Backend lokal tetap mengakses **dev**, yang sekarang memiliki data DEMO permanen. Database aplikasi bernama **caps2tone**, schema **public**.

## Perubahan skema

| Bagian | Implementasi |
|---|---|
| ID entitas dan foreign key | Integer auto-increment. UUID sebelumnya tersimpan di `legacy_id`; semua relasi lama dipetakan ulang. |
| Enum | `user_role`, `asset_kind`, `mapping_status`, `label_status`, `area_type`, `schedule_status`, `match_result`, `history_field`. |
| Pengguna | `areas area_type[]`, `is_active`, `updated_at`; username unik tanpa membedakan kapital. |
| Password | Akun baru bcrypt cost 12; hash scrypt akun lama tetap dapat diverifikasi. Maksimum password bcrypt 72 byte UTF-8. |
| Kantor | `created_at`, area dapat NULL sesuai dokumen; area jadwal tetap divalidasi terhadap layanan teknisi. |
| Aset | Kolom canonical `kondisi`; ref/status/kondisi/asset_code NOT NULL dengan default string kosong. |
| Audit | `history_field='kondisi'`, trigger `log_asset_changes`, actor transaksi `app.user_id`. |
| Jadwal | `updated_at`; jadwal tanpa penugasan dapat dibaca/dikerjakan teknisi pada area layanannya. |
| Laporan | Filter tanggal memakai `scanned_at` dalam `APP_TIMEZONE`, default Asia/Jakarta. |
| Dashboard | `done` dan `percent` menghitung aset `sudah` sesuai queryDB. `progress_percent` mempertahankan ukuran penyelesaian inventaris `(sudah+tidak_ditemukan)/total` untuk kompatibilitas. |
| Log Telegram | INSERT `(type,payload,success)` bekerja; dedupe_key dapat dibuat otomatis. Cron tetap memasok kunci stabil sendiri. |

Migrasi yang diterapkan dan checksum-nya tercatat di `schema_migrations`: `001_initial.sql`, `002_align_querydb.sql`, dan `003_notification_log_defaults.sql`. Migrasi 002 diuji dengan data lama berisi user, area, sesi, chassis/modul, jadwal, scan, dan riwayat sebelum diterapkan di Neon. Tidak ada reset tabel yang diperlukan untuk peningkatan ini.

Kolom/tabel pendukung tetap tersedia: `sessions` untuk autentikasi, `technician_areas` sebagai relasi kompatibilitas yang disinkronkan dengan `users.areas`, `schema_migrations`, UUID `legacy_id`, serta deduplikasi/retry pada `notification_logs`. FK dan constraint tambahan mempertahankan aturan aplikasi: jadwal aktif unik per kantor/tanggal, parent chassis sekantor, dan pemeriksaan hasil scan/label.

## Pengiriman dan pembacaan row melalui API

1. Login admin lewat `POST /api/auth/login` dengan username dan password dari `.env.local`.
2. Browser/Postman menyimpan cookie sesi; kirim `X-CSRF-Token` dari `data.csrf_token` untuk mutasi.
3. Buat kantor dengan `POST /api/offices` dan gunakan ID integer dari respons.
4. Buat aset lewat JSON `POST /api/assets`, atau gunakan impor XLSX.
5. Baca kembali memakai `GET /api/assets` dan `GET /api/assets/:id`.
6. Buat jadwal melalui `POST /api/schedules`; teknisi login lalu mencatat scan dengan `POST /api/mapping-results`.
7. Admin membaca progres, laporan, dan riwayat dari database.

Contoh kantor:

```json
{"code":"KTR-BARU","name":"Kantor Baru","address":"Alamat kantor","area":"grobogan"}
```

Contoh aset (ganti `office_id` dengan ID respons kantor):

```json
{"kind":"chassis","eq":"EQ-BARU-001","serial_number":"SN-BARU-001","office_id":6,"ref":"REF-001","status":"Aktif","kondisi":"Baik","asset_code":"ASET-001"}
```

Contoh modul memakai `kind: "module"` dan `parent_id` integer dari chassis sekantor. SN dinormalisasi trim/uppercase. Untuk hasil ganda, pilih `asset_id` salah satu kandidat pada request scan. Untuk `not_found`, `asset_id` boleh menunjuk aset inventaris yang diharapkan pada kantor jadwal; statusnya menjadi `tidak_ditemukan`. Tanpa pilihan aset, scan tetap tercatat dengan asset_id NULL. Pencocokan teknisi dibatasi kantor penugasannya.

`PATCH /api/assets/:id` menerima `kondisi` serta alias lama `condition`; respons aset menyertakan keduanya. Jika dua nama dikirim dengan nilai berbeda, server menolak request. Nilai kosong disimpan sebagai string kosong sesuai skema. Setiap perubahan REF/STATUS/KONDISI dicatat di riwayat secara atomik.

Admin dapat membuat akun dengan `POST /api/users` memakai `name`, `username`, `password`, `role`, dan `areas`. `PATCH /api/users/:id` menerima perubahan area, chat ID Telegram, password, atau `is_active`. Akun nonaktif tidak dapat login atau memakai sesi lama. Perubahan hak akses/password mencabut sesi terkait. Pengubahan role/area teknisi yang masih memiliki jadwal aktif memerlukan pengalihan jadwal lebih dahulu. Admin aktif terakhir dilindungi.

## Data DEMO permanen

Pada 5 November 2026 pengguna menyetujui data DEMO di dev. Data dibuat melalui HTTP API normal dan dibaca ulang dari pool PostgreSQL terpisah setelah commit:

- Dua kantor `DEMO-GRB` dan `DEMO-SLO` dengan nama berawalan `[DEMO]`.
- Enam aset: dua chassis dan empat modul. Modul pada setiap kantor berbagi SN untuk mencoba hasil multiple.
- Dua jadwal dengan teknisi sesuai area, enam hasil scan found/multiple/not_found, dan dua riwayat perubahan REF.
- Satu log `demo_verification` dengan `success=false`, `sent_at=null`, `no_message_sent=true`; tidak ada pengiriman Telegram.

ID dan SN terkini tersedia di [demo-data.json](demo-data.json). Data ini adalah contoh pengembangan, bukan inventaris asli. Main berisi skema yang sama, tanpa data DEMO.

`npm run db:demo` dibatasi pada endpoint dev proyek ini. Menjalankannya ulang pada hari yang sama tidak menggandakan kantor, aset, atau scan awal dan tidak menimpa akun/penugasan yang sudah berubah. Hari baru dapat memiliki jadwal DEMO baru. ID sequence dapat memiliki celah setelah pengujian rollback; gunakan ID respons API.

Koleksi [Postman](Caps2Tone.postman_collection.json) sudah memuat ID DEMO. Isi password lokal, jalankan login, kemudian GET aset/jadwal/laporan. Untuk mencoba sisi teknisi, login sebagai `teknisi.grobogan` atau `teknisi.solo` memakai password seed teknisi. Pembuatan entitas melalui koleksi menyimpan ID respons untuk request berikutnya. Swagger tersedia pada `/docs` setelah server dijalankan.

## Hasil verifikasi

- Lint, build, dan 25 pengujian otomatis lulus.
- Pengujian HTTP baca/tulis ke Neon dengan fixture rollback lulus; 0 fixture tertinggal.
- Pengisian DEMO di-commit dan dibaca dari koneksi terpisah. Pengisian ulang pada hari yang sama mempertahankan 6 aset dan 6 scan.
- Perbandingan skema main/dev menghasilkan diff kosong: 10 tabel, 8 enum, 12 foreign key, 35 index, dan 8 trigger.

Detail inventaris skema: [database-schema-verification.json](database-schema-verification.json). Detail pengujian API sementara: [database-api-verification.json](database-api-verification.json).
