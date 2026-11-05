# Panduan pengujian backend Caps2Tone

Gunakan branch Neon **dev-backend-fastify**, database **caps2tone**, schema **public** yang sudah terkonfigurasi di `.env.local`. Seluruh perintah dijalankan dari folder backend. Node.js minimal versi 22.

## 1. Pemeriksaan otomatis kode

```powershell
npm run check
```

Target: lint dan build berhasil, lalu **25 test pass, 0 fail**, proses berakhir dengan exit code 0. Suite mencakup autentikasi, sesi, CSRF, role, input tidak valid, area teknisi, jadwal, pencocokan SN, scan, label, audit, impor/ekspor, transaksi, migrasi dengan data lama, dashboard, laporan, dan log/deduplikasi/retry Telegram. Database test memakai PostgreSQL tertanam PGlite.

Jika dependency belum terpasang, jalankan `npm ci` terlebih dahulu. Untuk melihat penyebab kegagalan secara terpisah:

```powershell
npm run lint
npm run build
npm test
```

## 2. Koneksi dan baca/tulis pada Neon sungguhan

```powershell
npm run smoke
npm run smoke:write
```

`smoke` menjalankan server HTTP sementara, memeriksa health, login akun seed, tujuh endpoint data, logout, dan penolakan sesi lama. Akun/password dibaca dari variabel seed dalam `.env.local`.

`smoke:write` menggunakan fixture sementara untuk menguji HTTP dan operasi SQL ke Neon: pengguna/area/sesi, kantor, dry run dan impor XLSX, relasi chassis/modul, perubahan aset, riwayat audit, jadwal, found/multiple/not_found, scan/label, progres, laporan/ekspor, dan log. Seluruh fixture selalu rollback.

Target laporan:

```json
{
  "status": "passed",
  "fixture_records_remaining": 0,
  "fixture_changes_committed": false,
  "telegram_messages_sent": 0
}
```

Laporan tersimpan di `docs/database-api-verification.json`. Rollback adalah perilaku yang diharapkan pada tes ini: data sementara tidak akan muncul setelah proses selesai.

Untuk menyiapkan data yang tetap terlihat di Postman/Neon:

```powershell
npm run db:demo
npm run docs:generate
```

Data DEMO di-commit dan diverifikasi melalui pool database terpisah. Target awal: 2 kantor DEMO, 6 aset, 2 jadwal, 6 scan, dan 2 riwayat perubahan. Pengisian ulang pada tanggal yang sama tidak menggandakan data awal. Pada tanggal baru, jadwal/scan DEMO untuk hari tersebut dapat dibuat. ID terbaru disimpan di `docs/demo-data.json`; generate ulang dan impor ulang koleksi Postman setelah memperbarui DEMO.

## 3. Menjalankan API untuk Postman

```powershell
npm run dev
```

Biarkan terminal ini berjalan. Base URL default `http://localhost:3001`. Swagger: `http://localhost:3001/docs`. `GET /health` harus mengembalikan 200 dan `data.status="ok"`.

Untuk menguji server yang sedang berjalan dengan klien HTTP langsung, buka terminal kedua:

```powershell
npm run http:probe
```

Perintah ini mengirim request sungguhan ke `http://127.0.0.1:3001`, tidak membuat server sendiri dan tidak menggunakan Fastify inject. Tes mencakup cookie/CSRF login, data admin/teknisi, ekspor XLSX, dry-run multipart, found/multiple/not_found, penolakan akses, dan POST/PATCH/GET/DELETE kantor sementara yang kemudian dibersihkan. Tidak ada pesan Telegram dikirim. Setiap request dibatasi 15 detik. Laporan: `docs/http-probe-report.json`. Baseline yang telah dijalankan: **44 pemeriksaan lulus, 0 gagal**.

Koleksi Postman terbaru memakai `base_url=http://127.0.0.1:3001` dan memiliki request ping `GET /health`. Alamat IPv4 ini berhasil diuji langsung. Pada server saat pemeriksaan, listener IPv6 `[::1]:3001` tidak tersedia. Penyebab loading pada aplikasi Postman belum dapat dipastikan dari pemeriksaan UI; hasil request HTTP langsung tercatat di laporan.

Impor `docs/Caps2Tone.postman_collection.json`. Isi variabel koleksi:

| Variabel | Nilai |
|---|---|
| `base_url` | `http://localhost:3001` |
| `username` | Akun admin, default `admin` |
| `password` | Nilai `SEED_ADMIN_PASSWORD` dari `.env.local` |
| `scheduled_date` | Tanggal pengujian pada zona waktu aplikasi, format YYYY-MM-DD |
| `cron_secret` | Isi saat menguji cron memakai nilai `CRON_SECRET` |

`office_id`, `asset_id`, `schedule_id`, dan `technician_id` sudah diisi dari DEMO saat koleksi dibuat. Untuk data baru, respons POST kantor/aset/pengguna/jadwal otomatis menyimpan ID terkait ke variabel koleksi.

Jalankan request sesuai urutan skenario dan role di bawah. Request mutasi di koleksi mencakup perubahan status final, pembatalan, dan penghapusan kantor; menjalankan seluruh daftar sebagai satu urutan tidak mewakili suite otomatis. Assertion otomatis utama dijalankan melalui `npm run check`.

Login memakai POST `/api/auth/login`. Script koleksi menyimpan `data.csrf_token` ke variabel `csrf_token`; cookie jar Postman menyimpan sesi. Mutasi setelah login memerlukan header `X-CSRF-Token: {{csrf_token}}`. Jika membuat request sendiri, gunakan Body → raw → JSON untuk payload JSON. Login kembali setiap mengganti pengguna; token CSRF mengikuti sesi yang baru.

## 4. Pengujian admin dengan data DEMO

| Request | Hasil yang diharapkan |
|---|---|
| POST `/api/auth/login` | 200; user role admin, cookie sesi, csrf_token |
| GET `/api/auth/me` | 200; akun admin yang sedang login |
| GET `/api/users?role=teknisi&is_active=true` | 200; daftar teknisi aktif dan area berupa array |
| GET `/api/offices?search=DEMO` | 200; dua kantor DEMO |
| GET `/api/assets?search=DEMO` | 200; enam aset DEMO pada kondisi awal |
| GET `/api/assets/:id` | 200; detail aset dengan ID integer dan kondisi |
| PATCH `/api/assets/:id` dengan REF yang berbeda | 200; nilai baru tersimpan |
| GET `/api/assets/:id/history` | 200; mencatat field, nilai lama/baru, dan pengubah |
| GET `/api/dashboard/summary` | 200; jumlah aset/status dari database |
| GET `/api/dashboard/progress` | 200; progres per kantor |
| GET `/api/reports/mapping` | 200; enam scan DEMO awal |
| GET `/api/assets/export?search=DEMO` | 200; file XLSX dapat dibuka |
| GET `/api/reports/mapping/export` | 200; file laporan XLSX dapat dibuka |

Untuk PATCH, contoh payload `{"ref":"UJI-REF-BARU","kondisi":"Baik"}`. Ganti nilai REF jika mengulangi tes. Nilai yang tidak berubah tidak menghasilkan riwayat baru.

## 5. Pengujian pembuatan data baru dan alur teknisi

Gunakan kantor pengujian baru berawalan `UJI-` agar hasil pengujian manual terpisah dari baseline DEMO. Pakai kode/EQ baru untuk setiap skenario baru.

1. Login admin. POST `/api/offices` dengan `{"code":"UJI-GRB-001","name":"Kantor Pengujian","area":"grobogan"}` → 201; simpan office_id respons.
2. POST `/api/assets` untuk chassis: `{"kind":"chassis","eq":"UJI-CHASSIS-001","serial_number":"UJI-SN-CHASSIS","office_id":<office_id>,"kondisi":"Baik"}` → 201; simpan id chassis.
3. Buat dua aset module dengan EQ berbeda, parent_id chassis tadi, office_id yang sama, dan serial_number identik `UJI-SN-MODUL` → masing-masing 201. Catat kedua ID modul.
4. Baca GET `/api/assets?office_id=<office_id>` → tiga aset, relasi parent_id benar. Periksa row di Neon pada branch dev untuk memastikan data tersimpan setelah request selesai.
5. POST `/api/schedules` dengan office_id tersebut, area grobogan, scheduled_date hari ini, dan assigned_to ID `teknisi.grobogan` dari daftar pengguna → 201. Simpan schedule_id.
6. POST `/api/auth/logout`, kemudian login sebagai `teknisi.grobogan` menggunakan `SEED_TECHNICIAN_PASSWORD`. Variabel koleksi `password` perlu diganti ke password teknisi saat mengganti login.
7. GET `/api/schedules` → jadwal milik teknisi dan jadwal tanpa penugasan yang sesuai area. GET `/api/technician/assets?schedule_id=<schedule_id>` → tiga aset kantor pengujian.
8. POST `/api/scan/match` memakai schedule_id dan serial_number di tabel berikut.

| serial_number | `data.result` |
|---|---|
| `UJI-SN-CHASSIS` | `found` |
| `UJI-SN-MODUL` | `multiple`, dua kandidat |
| `UJI-SN-TIDAK-ADA` | `not_found`, daftar kosong |

9. POST `/api/mapping-results` dengan `{"schedule_id":<schedule_id>,"scanned_sn":"UJI-SN-CHASSIS","label_attached":true,"label_code":"UJI-LABEL-001"}` → 201; jadwal menjadi berjalan, aset sudah termapping, label terpasang.
10. Kirim hasil multiple dengan scanned_sn modul dan asset_id salah satu kandidat → 201; result tetap multiple dan aset pilihan ditandai sudah.
11. Kirim SN asing tanpa asset_id → 201, result not_found. Jika menyertakan ID aset inventaris yang diharapkan di kantor yang sama, aset tersebut menjadi tidak_ditemukan.
12. Logout teknisi, login ulang admin, baca laporan dengan filter schedule_id, progres kantor, riwayat, dan ekspor. Setiap scan yang dikirim memiliki satu row hasil.
13. Terakhir, PATCH jadwal dengan `{"status":"selesai"}` → 200. Scan berikutnya pada jadwal tersebut harus ditolak 409.

Placeholder `<office_id>` dan `<schedule_id>` harus diganti dengan angka respons API agar payload valid JSON. ID di sini berupa integer, bukan UUID.

## 6. Pengguna, impor, pembatalan, dan validasi gagal

Untuk pengguna: buat akun teknisi pengujian dengan nama/username baru, password minimal 12 karakter, role teknisi, dan areas `["grobogan"]` → 201. Coba login akun itu; lalu admin mengubah `is_active=false` lewat PATCH pengguna. Login berikutnya dan penggunaan sesi lamanya harus ditolak 401. Menghapus hak admin aktif terakhir harus ditolak 409.

Untuk impor: pilih Body → form-data, field **file** bertipe File, unggah XLSX sesuai header di README. `dry_run=true` harus 200 dan tidak mengubah aset/riwayat. `dry_run=false` harus 201 dan data terlihat melalui GET. File dengan kantor/parent tidak valid atau formula sel harus ditolak 422 dengan nomor baris; seluruh impor tersebut rollback. File di atas batas ukuran harus ditolak 413.

Untuk pembatalan: gunakan jadwal pengujian yang masih aktif. DELETE `/api/schedules/:id` → 200 dan status dibatalkan; riwayat scan tetap tersedia. Untuk penghapusan kantor, gunakan kantor kosong khusus pengujian → 204; kantor yang dipakai aset/jadwal → 409.

| Skenario gagal yang sengaja dicoba | Status benar |
|---|---|
| GET aset setelah logout / tanpa cookie | 401 |
| Teknisi mengakses GET `/api/assets` atau mutasi khusus admin | 403 |
| Mutasi dengan cookie valid tetapi CSRF kosong/salah | 403 |
| Mengakses jadwal teknisi lain / kantor di luar area penugasan | 403 |
| Dua jadwal aktif pada kantor dan tanggal yang sama | 409 |
| EQ atau username duplikat | 409 |
| Tanggal jadwal sebelum hari ini, field wajib kosong, ID bukan integer | 422 |
| ID integer valid tetapi tidak ada | 404 |
| Scan pada jadwal yang sudah selesai/dibatalkan atau bukan hari ini | 409 |

Tes dinilai pass jika status aktual sama dengan status yang diharapkan. Respons 401/403/409/422 pada skenario penolakan merupakan hasil yang benar.

## 7. Telegram dan cron sungguhan

Tes otomatis menguji pengiriman melalui sender pengganti; tes end-to-end Telegram membutuhkan bot dan penerima nyata.

1. Isi `TELEGRAM_BOT_TOKEN` dan `TELEGRAM_CHAT_ID` pada `.env.local` untuk mode group. Bot harus dapat mengirim pesan ke grup tujuan. Untuk mode technician, isi chat ID pengguna melalui API pengguna.
2. Restart server setelah mengganti environment. Isi variabel Postman `cron_secret` dari `CRON_SECRET`.
3. GET `/api/cron/notify-schedule` dengan `Authorization: Bearer {{cron_secret}}` → 200; pesan diterima dan log sukses tercatat.
4. Panggil lagi untuk hari/penerima yang sama → 200 dengan skipped; pesan sukses sebelumnya tidak dikirim ulang.
5. GET `/api/cron/notify-results` dengan header yang sama → 200; ringkasan diterima.
6. GET `/api/notifications/logs` sebagai admin → log sukses dengan sent_at terisi. Konfigurasi Telegram yang belum diisi menghasilkan 503; secret salah menghasilkan 401.

Data DEMO menyertakan log contoh tanpa pengiriman pesan; log itu bukan bukti Telegram end-to-end. Eksekusi cron terjadwal di Vercel diverifikasi setelah backend benar-benar dideploy ke proyek Vercel tujuan.

## Kriteria lulus

Kode lulus lint/build/25 tes, smoke Neon berhasil, smoke:write berstatus passed dengan nol fixture tersisa, operasi manual commit dan read-back cocok, audit muncul, dan seluruh skenario penolakan menghasilkan status yang tepat. Untuk menyatakan integrasi Telegram/Vercel juga lulus end-to-end, tambahkan bukti pesan nyata diterima dan cron berjalan pada deployment tujuan.
