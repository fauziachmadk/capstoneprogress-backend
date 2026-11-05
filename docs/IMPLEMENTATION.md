# Status implementasi terhadap BACKEND-TASKS.md

## Adaptasi yang disetujui

- Backend terpisah memakai Node.js + Fastify + TypeScript, menggantikan route handler/proxy Next.js pada repo backend ini.
- SQL langsung dan `pg`, tanpa Prisma/Drizzle. Migrasi SQL memiliki lock, transaksi, dan checksum.
- Sesi acak lewat cookie httpOnly, hash token di database, logout mencabut sesi, CSRF untuk mutasi.
- Skema terkini mengikuti queryDB.md: ID integer dan kolom `kondisi`; `condition` tetap alias API untuk kompatibilitas. UUID sebelumnya disimpan dalam `legacy_id`.
- Keputusan izin kondisi, penugasan wajib, dan pola Telegram tersedia lewat environment; default konservatif tercantum di README.

## Fitur backend tersedia

- [x] Login/logout, sesi, role per handler, pembatasan origin dan CSRF.
- [x] Skema seluruh tabel, FK/CHECK/index, seed admin dan tiga teknisi, dukungan dua area.
- [x] Jadwal teknisi berdasarkan sesi, bukan technician-picker mock.
- [x] Pencocokan SN ternormalisasi dengan found/not_found/multiple dan batas kantor penugasan.
- [x] Satu baris per scan, validasi pilihan aset, status mapping dan label atomik.
- [x] Perubahan REF/STATUS/KONDISI + asset_history atomik, termasuk impor.
- [x] Daftar/pencarian/filter/pagination aset dan riwayat.
- [x] Impor XLSX: validasi baris, upsert EQ, chassis/modul, dry run, rollback keseluruhan, limit file.
- [x] Ekspor aset XLSX sesuai filter dari server.
- [x] CRUD jadwal, aturan area/teknisi/tanggal, constraint jadwal aktif duplikat.
- [x] Daftar/CRUD kantor serta daftar pengguna untuk penugasan.
- [x] Dashboard progres kantor, laporan scan, ekspor laporan.
- [x] Telegram grup/per teknisi, ringkasan harian/per kantor, cron secret, logs dan deduplikasi.
- [x] Konfigurasi fungsi dan cron Vercel, environment example, ERD, Swagger/OpenAPI, koleksi Postman, CI.
- [x] Pengujian integrasi dengan PostgreSQL tertanam; perintah lint/build/test tersedia.
- [x] Proyek Neon Singapore, branch pengembangan, migrasi, seed, dan smoke test HTTP dengan koneksi Neon sungguhan; detail di NEON.md.
- [x] Skema pada main dan dev terverifikasi identik: 10 tabel, 8 enum, 12 foreign key, 35 index, 8 trigger, dan checksum migrasi sama.
- [x] Uji HTTP baca/tulis ke tabel Neon melalui `npm run smoke:write`, dengan rollback seluruh fixture dan pemeriksaan 0 record uji tersisa.
- [x] Penyesuaian queryDB.md, API JSON pengguna/aset, akun aktif/nonaktif, laporan menurut tanggal scan, dan jadwal tanpa penugasan sesuai area.
- [x] Data DEMO permanen di dev sesuai persetujuan pengguna, diverifikasi dari koneksi terpisah dan diuji pengisian ulang tanpa duplikasi.

## Memerlukan data atau akses dari tim

- [ ] Dataset EQ–SN asli: pemeriksaan nama kolom dan impor awal sungguhan. Tidak tersedia di folder awal.
- [ ] Repo frontend: penggantian mock/provider, guard/redirect halaman, loading state, build/lint frontend. Tidak tersedia di folder awal.
- [ ] Telegram: token bot dan penerima nyata; pengiriman sungguhan belum dapat diuji tanpa keduanya.
- [ ] Vercel: akun/proyek target dan konfigurasi domain untuk deployment sungguhan.
- [ ] Git remote/PR serta review minimal satu anggota lain.
- [ ] Uji lapangan teknisi, SUS, jadwal sprint/milestone dan nama pemilik modul.
- [ ] Persetujuan akhir tim mengenai nilai konfigurasi kebijakan.

`PLANNING.md`, `CLAUDE.md`, kode frontend, dan dataset yang dirujuk dokumen asli belum diberikan. queryDB.md sudah tersedia dan menjadi acuan penyesuaian skema. Checklist ini membedakan kode yang tersedia dari pekerjaan eksternal yang belum terverifikasi.
