# Lingkungan Neon

Dibuat pada 5 November 2026 atas permintaan pengguna.

| Properti | Nilai |
|---|---|
| Proyek | `caps2tone-backend` |
| Project ID | `steep-smoke-25342823` |
| Region | Singapore — `aws-ap-southeast-1` |
| PostgreSQL | 17 |
| Database | `caps2tone` |
| Branch utama | `main` — `br-small-firefly-azev67bu` |
| Branch pengembangan aktif | `dev-backend-fastify` — `br-nameless-hall-azf7bm95` |

Koneksi `.env.local` menunjuk branch pengembangan. URL pooled digunakan aplikasi; URL direct digunakan migrasi. AUTH_SECRET, CRON_SECRET, dan password seed dibuat acak secara lokal. Nilai rahasia tidak dicantumkan di dokumentasi atau Git; pengguna dapat membacanya di `.env.local`.

Kedua branch sudah memiliki skema lengkap dari migrasi 001, 002, dan 003: **10 tabel, 8 enum, 12 foreign key, 35 index, dan 8 trigger**. Migrasi pada `main` dijalankan dalam satu transaksi dengan advisory lock dan dicatat di `schema_migrations`. Perbandingan skema Neon antara `main` dan `dev-backend-fastify` menghasilkan diff kosong. Checksum migrasi sama pada kedua branch.

`main` berisi skema dan tiga catatan migrasi; akun serta data bisnis belum diisi. Branch pengembangan berisi 5 akun seed, 2 kantor contoh awal, serta data DEMO yang disetujui pengguna: 2 kantor, 6 aset, 2 jadwal, 6 scan, 2 riwayat, dan 1 log contoh tanpa pengiriman pesan. Data DEMO di-commit dan dapat dibaca melalui API; detail ID di demo-data.json. Backend lokal tetap memakai branch pengembangan; koneksi `.env.local` tidak diganti.

## Tabel dan alur data

| Tabel | Cara mengisi / membaca |
|---|---|
| `users` | Seed akun; dibaca login dan `GET /api/users`. |
| `technician_areas` | Seed area teknisi; divalidasi saat penugasan. |
| `sessions` | Login membuat sesi, logout mencabut sesi. |
| `offices` | CRUD `/api/offices`. |
| `assets` | Impor `/api/assets/import`; baca `/api/assets` atau `/api/technician/assets`; perubahan lewat PATCH dan hasil scan. |
| `mapping_schedules` | CRUD `/api/schedules`; teknisi membaca jadwal miliknya. |
| `mapping_results` | `POST /api/mapping-results`; dibaca laporan `/api/reports/mapping`. |
| `asset_history` | Trigger otomatis untuk REF/STATUS/KONDISI; baca `/api/assets/:id/history`. |
| `notification_logs` | Dicatat cron Telegram; baca `/api/notifications/logs`. |
| `schema_migrations` | Diisi sistem migrasi, menyimpan nama dan checksum SQL. |

Urutan pengisian data: akun dan area teknisi → kantor → impor dataset aset → jadwal dan penugasan → scan → laporan. Riwayat aset, sesi, dan log notifikasi dikelola otomatis oleh backend. EQ dan kode kantor unik; SN sengaja dapat berulang. KONDISI memakai nama kolom `kondisi`, ID berupa integer, dan UUID lama tersimpan pada `legacy_id`. Penyesuaian terhadap queryDB.md dijelaskan di [QUERYDB-IMPLEMENTATION.md](QUERYDB-IMPLEMENTATION.md). Detail relasi tersedia di [ERD](ERD.md).

## Verifikasi baca/tulis

`npm run smoke:write` menjalankan server HTTP sementara terhadap koneksi Neon di `.env.local`, menguji login, CRUD kantor, dry run dan impor tiga aset chassis/modul, audit tiga perubahan, jadwal teknisi, pencocokan found/multiple/not_found, penyimpanan scan/label, progres, laporan, ekspor XLSX, baca/tulis log uji, dan logout. Tidak ada pesan Telegram dikirim.

Seluruh fixture berada dalam satu transaksi luar yang selalu rollback; transaksi handler menggunakan savepoint selama pengujian. Setelah rollback, query terpisah memastikan **0 record uji tersisa**. Ini memverifikasi operasi SQL dan API pada Neon, tanpa melakukan commit data fixture. Transaksi aplikasi normal tetap menggunakan implementasi `pg` yang sama seperti sebelumnya.

Hasil aktual disimpan di [database-api-verification.json](database-api-verification.json). Inventaris tabel dan pemeriksaan kesamaan skema disimpan di [database-schema-verification.json](database-schema-verification.json). `npm run lint` dan `npm run build` juga lulus setelah penambahan perintah verifikasi.

## Membuka tabel di Neon

Pilih proyek `caps2tone-backend`, branch yang ingin diperiksa, database **`caps2tone`**, dan schema **`public`**. Database `postgres` merupakan database bawaan dan bukan tempat tabel aplikasi ini.

- [Tabel pada branch main](https://console.neon.tech/app/projects/steep-smoke-25342823/branches/br-small-firefly-azev67bu).
- [Tabel pada branch dev-backend-fastify](https://console.neon.tech/app/projects/steep-smoke-25342823/branches/br-nameless-hall-azf7bm95).

Perubahan skema berikutnya ditulis sebagai file migrasi baru, diuji di dev, lalu diterapkan ke main dengan catatan migrasi/checksum yang sama. `npm run db:migrate` memakai koneksi direct di `.env.local`, yang saat ini menunjuk dev. Jangan mengubah file migrasi yang sudah diterapkan. Data DEMO hanya disimpan di dev; main tetap berisi skema dan catatan migrasi.

Console: [proyek Neon Caps2Tone](https://console.neon.tech/app/projects/steep-smoke-25342823).
