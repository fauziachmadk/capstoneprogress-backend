# BACKEND-TASKS — Pembagian Tugas Backend

Turunan dari `PLANNING.md` (baca dulu), disesuaikan dengan frontend yang sudah jadi. Frontend saat ini masih memakai data tiruan di `lib/mock-data.ts` dan state di memori browser. Tugas backend adalah menggantinya dengan database NeonDB + API sungguhan.

**Stack:** Next.js 16 (App Router) + TypeScript, NeonDB (PostgreSQL), Telegram Bot API (notifikasi saja), deploy di Vercel.

> **Next.js 16:** file middleware bernama `proxy.ts`, dan `params` di page bersifat Promise. Baca `node_modules/next/dist/docs/` sebelum menulis kode yang bergantung pada API Next.js.

---

## A. Aturan wajib (semua anggota)

1. Cek role (`admin` / `teknisi`) di `proxy.ts` **dan** diulang di setiap route handler / server action. Proxy saja tidak cukup.
2. Semua secret (`DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `AUTH_SECRET`, `CRON_SECRET`) hanya di `.env.local` dan Vercel. Jangan di-commit dan jangan dipakai di komponen client. Sediakan `.env.example` tanpa nilai.
3. Setiap perubahan REF / STATUS / KONDISI aset **wajib** ditulis ke `asset_history`, termasuk perubahan lewat impor Excel.
4. Pencocokan SN selalu menangani tiga hasil: `found`, `not_found`, `multiple`.
5. Password disimpan sebagai hash. Endpoint cron dilindungi `CRON_SECRET`.
6. Jangan menambah fitur di luar scope (procurement, keuangan, AI, IoT, GPS real-time).
7. Nama kode / variabel / kolom dalam bahasa Inggris, teks antarmuka dalam bahasa Indonesia.
8. Branch `feature/<nama-fitur>`, merge lewat Pull Request, minimal 1 review dari anggota lain.
9. Menemukan hal **[TBD]**? Tanya tim dulu, jangan putuskan sendiri (lihat bagian F).

---

## B. Pembagian tugas per fitur

Pemilik modul mengerjakan database, API, sampai menyambungkan ke halaman yang sudah ada. Nama anggota masih **[TBD]**.

| | Modul 1 | Modul 2 | Modul 3 |
|---|---|---|---|
| **Fokus** | Fondasi, auth, sisi teknisi | Pencocokan SN & data aset | Jadwal, monitoring, notifikasi |
| **Pemilik** | Anggota 1 | Anggota 2 | Anggota 3 |
| **Diuji oleh** | Anggota 2 | Anggota 3 | Anggota 1 |

### Modul 1 — Fondasi, auth, dan sisi teknisi

Paling berat karena menjadi dasar modul lain, kerjakan paling awal.

**Database**
- Setup NeonDB, koneksi, ORM, dan sistem migrasi (setelah ORM diputuskan).
- Tabel `users`, `technician_areas`.
- Seed akun admin dan beberapa teknisi untuk pengembangan.

**Tugas**
- [ ] `POST /api/auth/login`, `POST /api/auth/logout`: password hash, sesi lewat cookie `httpOnly`.
- [ ] `proxy.ts`: redirect berdasarkan login + role (`/admin/*` hanya admin, `/teknisi/*` hanya teknisi, `/login` publik).
- [ ] Helper bersama `requireRole("admin" | "teknisi")` untuk semua route handler.
- [ ] Halaman `/teknisi`: ambil jadwal teknisi yang login dari database (ganti `technician-picker` / `currentTechnician` milik mock).
- [ ] `POST /api/mapping-results`: simpan hasil scan (satu baris per scan), termasuk `label_attached` dan ubah `mapping_status` aset.
- [ ] Setup deploy Vercel dan environment variable.

**Halaman:** `/login`, `/teknisi`, `/teknisi/kantor/[officeId]`, `/teknisi/kantor/[officeId]/chassis/[chassisId]`
**Komponen:** `mapping-provider.tsx`, `mapping-workspace.tsx`, `chassis-workspace.tsx`, `chassis-list.tsx`, `office-list.tsx`

### Modul 2 — Pencocokan SN & data aset

**Database:** tabel `assets`, `asset_history` (index pada `assets.serial_number`).

**Tugas**
- [ ] `POST /api/scan/match`: cocokkan SN ke EQ. Normalisasi SN dulu (trim, uppercase). Logika awal ada di `lib/match.ts`.
  ```json
  { "result": "found | not_found | multiple", "assets": [] }
  ```
- [ ] `PATCH /api/assets/[id]`: ubah REF / STATUS (dan KONDISI, lihat [TBD]) + tulis `asset_history` dalam **satu transaksi**.
- [ ] `GET /api/assets`: daftar aset dengan pencarian (EQ, serial number, kode aset), filter kantor, pagination.
- [ ] `GET /api/assets/[id]/history`: riwayat perubahan aset.
- [ ] `POST /api/assets/import`: impor Excel (lihat rincian di bawah).
- [ ] `GET /api/assets/export`: ekspor Excel dari server, ikut filter pencarian. Versi client yang ada sekarang boleh dipertahankan dulu.
- [ ] Impor dataset awal EQ–SN (skrip seed sekali jalan atau lewat fitur impor).

**Rincian impor Excel**

Fitur "Impor Excel" di halaman Data Aset admin sudah dibuat di frontend (`lib/asset-excel.ts`). Pindahkan logikanya ke server:

| Kolom | Wajib | Keterangan |
|---|---|---|
| EQ | Ya | Kunci pembaruan |
| Jenis | Ya | `Chassis` atau `Modul` |
| Serial Number | Ya | |
| Kode Kantor | Ya | Harus ada di tabel `offices` |
| SN Chassis | Tidak | Hanya untuk Modul, menghubungkan ke chassis induk |
| REF, Status, Kondisi, Kode Aset | Tidak | |

- EQ sudah ada → perbarui aset + catat `asset_history`. EQ baru → buat aset baru.
- Validasi per baris, kembalikan daftar baris bermasalah beserta nomor barisnya.
- Hanya admin. Batasi ukuran file.
- Jalankan dalam transaksi. Sediakan mode *dry run* untuk pratinjau sebelum benar-benar disimpan.

**Halaman:** `/admin/aset` (`components/asset-table.tsx`), dan bagian pencocokan SN di halaman teknisi (bersama Anggota 1).

### Modul 3 — Jadwal, monitoring, dan notifikasi

**Database:** tabel `offices`, `mapping_schedules`, `notification_logs`.

**Tugas**
- [ ] `GET/POST/PATCH/DELETE /api/schedules`. Aturan yang sudah ada di frontend **harus diulang di server**:
  - tanggal wajib diisi dan tidak boleh sebelum hari ini,
  - satu kantor tidak boleh punya dua jadwal aktif (`terjadwal` / `berjalan`) di tanggal yang sama,
  - status: `terjadwal`, `berjalan`, `selesai`, `dibatalkan`,
  - teknisi yang ditugaskan opsional dan harus melayani area jadwal.
- [ ] `GET /api/offices` (dan CRUD kantor bila perlu).
- [ ] `GET /api/dashboard/progress`: progres per kantor (sudah / belum / tidak ditemukan).
- [ ] Laporan hasil mapping + ekspor (`/admin/laporan`).
- [ ] `lib/telegram.ts` (kirim pesan, token hanya di server).
- [ ] `GET /api/cron/notify-schedule` (pagi: jadwal hari ini) dan `GET /api/cron/notify-results` (sore/malam: ringkasan hasil).
- [ ] Validasi `CRON_SECRET`, catat ke `notification_logs`, `vercel.json` untuk Vercel Cron (cek batas frekuensi paket).

**Halaman:** `/admin` (`progress-dashboard.tsx`), `/admin/jadwal` (`schedule-manager.tsx`), `/admin/laporan`

---

## C. Rancangan database

Dasar: `PLANNING.md` bagian 7, ditambah hal yang sudah dipakai frontend (chassis/modul, area, status mapping per aset, kode label). Nama kolom asli dataset EQ–SN masih **[TBD]**; sesuaikan `assets` setelah file dataset dicek. ERD final disepakati bersama di Sprint 0.

### `users`
| Kolom | Keterangan |
|---|---|
| id | PK |
| name, username | username UNIQUE |
| password_hash | |
| role | `admin` / `teknisi` |
| telegram_chat_id | nullable |
| created_at | |

### `technician_areas` (teknisi bisa melayani 1 atau 2 area)
| Kolom | Keterangan |
|---|---|
| user_id | FK `users` |
| area | `grobogan` / `solo` |

PK `(user_id, area)`.

### `offices`
| Kolom | Keterangan |
|---|---|
| id | PK |
| code | UNIQUE, contoh `KTR-MJS` |
| name, address | |

### `assets`
| Kolom | Keterangan |
|---|---|
| id | PK |
| kind | `chassis` / `module` |
| parent_id | FK `assets`, nullable. Modul menunjuk chassis induknya |
| eq | UNIQUE (kunci pembaruan impor Excel) |
| serial_number | **Tidak** unique: satu SN bisa cocok ke banyak EQ (hasil `multiple`) |
| ref, status, kondisi, asset_code | |
| office_id | FK `offices` |
| mapping_status | `belum` / `sudah` / `tidak_ditemukan` |
| label_status | `belum` / `terpasang` |
| label_code | nullable, kode QR dari label fisik |
| created_at, updated_at | |

Index: `serial_number`, `eq`, `office_id`.

### `mapping_schedules`
| Kolom | Keterangan |
|---|---|
| id | PK |
| office_id | FK `offices` |
| area | `grobogan` / `solo` |
| scheduled_date | DATE |
| assigned_to | FK `users`, nullable |
| status | `terjadwal` / `berjalan` / `selesai` / `dibatalkan` |
| created_by | FK `users` |
| created_at | |

Constraint: *partial unique index* `(office_id, scheduled_date)` untuk status aktif, supaya aturan "1 kantor 1 jadwal aktif per tanggal" dijaga di level database juga.

### `mapping_results` (satu baris per scan)
| Kolom | Keterangan |
|---|---|
| id | PK |
| schedule_id | FK `mapping_schedules` |
| asset_id | FK `assets`, nullable bila `not_found` |
| scanned_sn | |
| result | `found` / `not_found` / `multiple` |
| scanned_by | FK `users` |
| scanned_at | |
| label_attached | BOOLEAN |

### `asset_history`
| Kolom | Keterangan |
|---|---|
| id | PK |
| asset_id | FK `assets` |
| field | `ref` / `status` / `kondisi` |
| old_value, new_value | |
| changed_by | FK `users` |
| changed_at | |

### `notification_logs`
| Kolom | Keterangan |
|---|---|
| id | PK |
| type | |
| payload | JSON |
| sent_at | |
| success | BOOLEAN |

**Catatan**
- Gunakan enum atau `CHECK` constraint untuk kolom bernilai terbatas.
- Perubahan aset + `asset_history` selalu dalam satu transaksi.
- Tentukan perilaku `ON DELETE`. Disarankan tidak menghapus fisik aset; pakai status.

---

## D. Daftar API

| Method | Endpoint | Peran | Pemilik |
|---|---|---|---|
| POST | `/api/auth/login` | publik | Modul 1 |
| POST | `/api/auth/logout` | login | Modul 1 |
| POST | `/api/scan/match` | teknisi | Modul 2 |
| POST | `/api/mapping-results` | teknisi | Modul 1 |
| GET | `/api/assets` | admin | Modul 2 |
| PATCH | `/api/assets/[id]` | teknisi, admin | Modul 2 |
| GET | `/api/assets/[id]/history` | admin | Modul 2 |
| POST | `/api/assets/import` | admin | Modul 2 |
| GET | `/api/assets/export` | admin | Modul 2 |
| GET/POST/PATCH/DELETE | `/api/schedules` | admin (GET juga teknisi: hanya jadwalnya sendiri) | Modul 3 |
| GET | `/api/offices` | login | Modul 3 |
| GET | `/api/dashboard/progress` | admin | Modul 3 |
| GET | `/api/cron/notify-schedule` | `CRON_SECRET` | Modul 3 |
| GET | `/api/cron/notify-results` | `CRON_SECRET` | Modul 3 |

Format respons dan kode error (400 / 401 / 403 / 404 / 409 / 422) disepakati bersama di Sprint 0 supaya seragam. Uji semua endpoint dengan Postman, termasuk skenario ditolak karena role salah.

---

## E. Urutan kerja

| Sprint | Target |
|---|---|
| **0** (bersama) | Setup repo, NeonDB, Vercel. Putuskan ORM dan auth. Sepakati ERD, format respons API, alur Git |
| **1** | M1: auth + proxy role + `users`. M2: `assets` + impor dataset. M3: `offices` + `mapping_schedules`. Tabel dibuat lewat migrasi, bukan manual di dashboard Neon |
| **2** | M2: API pencocokan (3 hasil). M3: CRUD jadwal. M1: halaman teknisi membaca jadwal dari database |
| **3** | M2: ubah REF/STATUS + riwayat, halaman data aset, impor/ekspor Excel. M3: dashboard progres. M1: `POST /api/mapping-results` |
| **4** | M3: Telegram + cron + laporan. Integrasi semua modul |
| **5** | Black-box testing, uji dengan teknisi, SUS, perbaikan, dokumentasi |

### Cara menyambungkan ke frontend (semua modul)

1. Buat API dan uji di Postman.
2. Ganti impor dari `lib/mock-data.ts` di komponen terkait dengan pemanggilan API / query server.
3. Hapus komponen demo (`components/demo-loading.tsx`), ganti dengan state loading yang asli.
4. Hapus data tiruan yang tidak terpakai lagi.
5. Pastikan `npm run build` dan `npm run lint` lolos sebelum PR.

> **cacheComponents aktif:** jangan memanggil `new Date()` / `Date.now()` saat render di komponen yang ikut prerender. Hitung di event handler / `useEffect`, atau bungkus dengan `<Suspense>`.

---

## F. Keputusan yang masih terbuka ([TBD], tanya tim dulu)

- [ ] ORM: Drizzle atau Prisma (menentukan perintah migrasi di `CLAUDE.md`).
- [ ] Library autentikasi: Auth.js atau JWT di cookie `httpOnly`.
- [ ] Nama kolom asli dataset EQ–SN (menentukan tabel `assets` final).
- [ ] Apakah KONDISI juga boleh diubah teknisi (selain REF dan STATUS).
- [ ] Apakah admin wajib menugaskan teknisi ke setiap jadwal.
- [ ] Penerima notifikasi: satu grup Telegram atau per teknisi.
- [ ] Isi notifikasi: per kantor atau satu ringkasan harian.
- [ ] Jenis kode SN di modul (barcode 1D atau QR) → library scan.
- [ ] Ukuran dataset aset (menentukan perlunya pagination dan ekspor di server).
- [ ] Durasi sprint dan tanggal milestone.
- [ ] Nama anggota untuk Modul 1, 2, 3.

---

## G. Definisi selesai (per fitur)

- [ ] Tabel dibuat lewat migrasi dan ada di ERD.
- [ ] Endpoint mengecek login + role di dalam handler.
- [ ] Input divalidasi di server (jangan percaya validasi di frontend).
- [ ] Perubahan REF / STATUS / KONDISI tercatat di `asset_history`.
- [ ] Sudah diuji di Postman, termasuk kasus gagal dan role salah.
- [ ] Halaman terkait tidak lagi memakai `mock-data`.
- [ ] `npm run build` dan `npm run lint` lolos.
- [ ] Pull Request sudah di-review minimal 1 anggota lain.
