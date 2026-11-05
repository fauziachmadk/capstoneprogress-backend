# queryDB.md

Query SQL untuk NeonDB (PostgreSQL), dibagi per modul. Skema mengikuti `PLANNING.md` bagian 7 dan `lib/types.ts`.

**Status implementasi backend:** struktur di dokumen ini sudah diterapkan melalui migrasi 002/003 pada Neon main dan dev. Untuk database yang sudah ada, gunakan file dalam `migrations/` dan catatan `schema_migrations`. Tabel runtime `sessions`, relasi kompatibilitas `technician_areas`, kolom `legacy_id`, dan deduplikasi notifikasi tetap dipertahankan. Panduan input/baca row, kompatibilitas API, serta data DEMO permanen tersedia di [docs/QUERYDB-IMPLEMENTATION.md](docs/QUERYDB-IMPLEMENTATION.md).

Catatan penggunaan:
- Untuk database baru, jalankan modul 0 sampai 8 berurutan (ada foreign key antar tabel). Untuk proyek backend ini gunakan sistem migrasi agar skema dan checksum tetap tercatat.
- Query bertanda `$1, $2, ...` adalah query berparameter untuk dipanggil dari kode (server only). Jangan menyusun SQL dengan string concatenation.
- Nama kolom di `assets` masih mengikuti draft. Sesuaikan jika nama kolom dataset asli berbeda **[TBD]**.
- Semua perubahan REF / STATUS / KONDISI wajib masuk `asset_history` (lihat modul 4).

---

## 0. Setup dasar

```sql
-- Tipe enum
CREATE TYPE user_role       AS ENUM ('admin', 'teknisi');
CREATE TYPE asset_kind      AS ENUM ('chassis', 'module');
CREATE TYPE mapping_status  AS ENUM ('sudah', 'belum', 'tidak_ditemukan');
CREATE TYPE label_status    AS ENUM ('terpasang', 'belum');
CREATE TYPE area_type       AS ENUM ('grobogan', 'solo');
CREATE TYPE schedule_status AS ENUM ('terjadwal', 'berjalan', 'selesai', 'dibatalkan');
CREATE TYPE match_result    AS ENUM ('found', 'not_found', 'multiple');
CREATE TYPE history_field   AS ENUM ('ref', 'status', 'kondisi');

-- Trigger pembaruan updated_at
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

---

## 1. Modul Pengguna dan Autentikasi (`users`)

```sql
CREATE TABLE users (
  id               serial PRIMARY KEY,
  name             text        NOT NULL,
  username         text        NOT NULL,
  password_hash    text        NOT NULL,            -- hash (bcrypt/argon2), bukan password asli
  role             user_role   NOT NULL,
  areas            area_type[] NOT NULL DEFAULT '{}', -- area layanan teknisi
  telegram_chat_id text,
  is_active        boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Username tidak peka huruf besar/kecil
CREATE UNIQUE INDEX users_username_key ON users (lower(username));

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

Query aplikasi:

```sql
-- Login: ambil user berdasarkan username ($1), lalu bandingkan hash di server
SELECT id, name, username, password_hash, role, areas
FROM users
WHERE lower(username) = lower($1) AND is_active;

-- Ambil user dari sesi (cek role di setiap route handler)
SELECT id, name, username, role, areas
FROM users
WHERE id = $1 AND is_active;

-- Daftar teknisi untuk dropdown penugasan jadwal
SELECT id, name, areas
FROM users
WHERE role = 'teknisi' AND is_active
ORDER BY name;

-- Tambah user ($3 = hash yang dibuat di server)
INSERT INTO users (name, username, password_hash, role, areas)
VALUES ($1, $2, $3, $4, $5)
RETURNING id;

-- Simpan chat id Telegram
UPDATE users SET telegram_chat_id = $2 WHERE id = $1;
```

Seed akun awal (ganti `<HASH>` dengan hasil hash, jangan simpan password polos):

```sql
INSERT INTO users (name, username, password_hash, role, areas) VALUES
  ('Administrator', 'admin',   '<HASH>', 'admin',   '{}'),
  ('Teknisi Contoh', 'teknisi', '<HASH>', 'teknisi', '{grobogan,solo}');
```

---

## 2. Modul Kantor (`offices`)

```sql
CREATE TABLE offices (
  id         serial PRIMARY KEY,
  code       text        NOT NULL UNIQUE,
  name       text        NOT NULL,
  address    text        NOT NULL DEFAULT '',
  area       area_type,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Query aplikasi:

```sql
-- Daftar kantor
SELECT id, code, name, address, area FROM offices ORDER BY name;

-- Detail kantor
SELECT id, code, name, address, area FROM offices WHERE id = $1;

-- Tambah kantor
INSERT INTO offices (code, name, address, area)
VALUES ($1, $2, $3, $4)
RETURNING id;

-- Ubah kantor
UPDATE offices
SET name = $2, address = $3, area = $4
WHERE id = $1;
```

---

## 3. Modul Aset (`assets`)

Chassis adalah induk, modul adalah anak (`parent_id`).

```sql
CREATE TABLE assets (
  id             serial PRIMARY KEY,
  kind           asset_kind     NOT NULL,
  parent_id      integer REFERENCES assets (id) ON DELETE SET NULL,
  eq             text           NOT NULL,
  serial_number  text           NOT NULL,
  ref            text           NOT NULL DEFAULT '',
  status         text           NOT NULL DEFAULT '',
  kondisi        text           NOT NULL DEFAULT '',
  asset_code     text           NOT NULL DEFAULT '',
  office_id      integer        NOT NULL REFERENCES offices (id),
  mapping_status mapping_status NOT NULL DEFAULT 'belum',
  label_status   label_status   NOT NULL DEFAULT 'belum',
  label_code     text,
  created_at     timestamptz    NOT NULL DEFAULT now(),
  updated_at     timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT assets_eq_key UNIQUE (eq),
  CONSTRAINT assets_parent_not_self CHECK (parent_id IS NULL OR parent_id <> id)
);

-- Pencocokan SN harus cepat dan tidak peka huruf besar/kecil
CREATE INDEX assets_serial_number_idx ON assets (upper(serial_number));
CREATE INDEX assets_office_idx        ON assets (office_id);
CREATE INDEX assets_parent_idx        ON assets (parent_id);
CREATE INDEX assets_mapping_status_idx ON assets (office_id, mapping_status);

CREATE TRIGGER assets_set_updated_at
  BEFORE UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

Query aplikasi:

```sql
-- Halaman Data Aset (admin). $1 = kata kunci atau NULL.
-- Pengurutan kolom dilakukan di klien; untuk data besar bisa dipindah ke server
-- dengan whitelist nama kolom (jangan masukkan input pengguna langsung ke ORDER BY).
SELECT a.id, a.kind, a.parent_id, a.eq, a.serial_number, a.ref, a.status,
       a.kondisi, a.asset_code, a.office_id, o.name AS office_name,
       a.mapping_status, a.label_status, a.label_code
FROM assets a
JOIN offices o ON o.id = a.office_id
WHERE $1::text IS NULL
   OR a.eq            ILIKE '%' || $1 || '%'
   OR a.serial_number ILIKE '%' || $1 || '%'
   OR a.asset_code    ILIKE '%' || $1 || '%'
ORDER BY a.eq
LIMIT $2 OFFSET $3;

-- Daftar chassis di satu kantor beserta progres modulnya (halaman teknisi)
SELECT c.id, c.eq, c.serial_number, c.mapping_status,
       count(m.id)                                          AS total_modules,
       count(m.id) FILTER (WHERE m.mapping_status = 'sudah') AS done_modules
FROM assets c
LEFT JOIN assets m ON m.parent_id = c.id
WHERE c.kind = 'chassis' AND c.office_id = $1
GROUP BY c.id
ORDER BY c.eq;

-- Modul di dalam satu chassis
SELECT id, eq, serial_number, ref, status, kondisi, asset_code,
       mapping_status, label_status, label_code
FROM assets
WHERE parent_id = $1
ORDER BY eq;

-- Impor Excel: upsert berdasarkan EQ. Riwayat perubahan ditulis terpisah (modul 4).
INSERT INTO assets (kind, parent_id, eq, serial_number, ref, status, kondisi, asset_code, office_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (eq) DO UPDATE
SET serial_number = EXCLUDED.serial_number,
    ref           = EXCLUDED.ref,
    status        = EXCLUDED.status,
    kondisi       = EXCLUDED.kondisi,
    asset_code    = EXCLUDED.asset_code,
    office_id     = EXCLUDED.office_id
RETURNING id;
```

---

## 4. Modul Riwayat Aset (`asset_history`)

Setiap perubahan REF / STATUS / KONDISI wajib tercatat. Cara paling aman: lakukan update aset **dan** insert riwayat dalam satu transaksi, atau pakai trigger di bawah agar tidak ada jalur yang terlewat.

```sql
CREATE TABLE asset_history (
  id         serial PRIMARY KEY,
  asset_id   integer       NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  field      history_field NOT NULL,
  old_value  text          NOT NULL DEFAULT '',
  new_value  text          NOT NULL DEFAULT '',
  changed_by integer       REFERENCES users (id),
  changed_at timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX asset_history_asset_idx ON asset_history (asset_id, changed_at DESC);
```

Trigger otomatis. Pengguna yang mengubah dikirim lewat setting transaksi `app.user_id`:

```sql
CREATE OR REPLACE FUNCTION log_asset_changes() RETURNS trigger AS $$
DECLARE
  uid integer := nullif(current_setting('app.user_id', true), '')::integer;
BEGIN
  IF NEW.ref IS DISTINCT FROM OLD.ref THEN
    INSERT INTO asset_history (asset_id, field, old_value, new_value, changed_by)
    VALUES (NEW.id, 'ref', OLD.ref, NEW.ref, uid);
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO asset_history (asset_id, field, old_value, new_value, changed_by)
    VALUES (NEW.id, 'status', OLD.status, NEW.status, uid);
  END IF;
  IF NEW.kondisi IS DISTINCT FROM OLD.kondisi THEN
    INSERT INTO asset_history (asset_id, field, old_value, new_value, changed_by)
    VALUES (NEW.id, 'kondisi', OLD.kondisi, NEW.kondisi, uid);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER assets_log_changes
  AFTER UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION log_asset_changes();
```

Query aplikasi (`PATCH /api/assets/[id]`), dijalankan dalam satu transaksi:

```sql
BEGIN;
SELECT set_config('app.user_id', $1::text, true);   -- id user dari sesi

UPDATE assets
SET ref = $3, status = $4, kondisi = $5
WHERE id = $2
RETURNING id, ref, status, kondisi;
COMMIT;
```

```sql
-- Riwayat satu aset (tombol "Riwayat" di Data Aset)
SELECT h.id, h.field, h.old_value, h.new_value,
       u.name AS changed_by, h.changed_at
FROM asset_history h
LEFT JOIN users u ON u.id = h.changed_by
WHERE h.asset_id = $1
ORDER BY h.changed_at DESC;
```

---

## 5. Modul Jadwal Mapping (`mapping_schedules`)

```sql
CREATE TABLE mapping_schedules (
  id             serial PRIMARY KEY,
  office_id      integer         NOT NULL REFERENCES offices (id),
  area           area_type       NOT NULL,
  scheduled_date date            NOT NULL,
  assigned_to    integer         REFERENCES users (id) ON DELETE SET NULL, -- opsional
  status         schedule_status NOT NULL DEFAULT 'terjadwal',
  created_by     integer         REFERENCES users (id),
  created_at     timestamptz     NOT NULL DEFAULT now(),
  updated_at     timestamptz     NOT NULL DEFAULT now()
);

CREATE INDEX mapping_schedules_date_idx     ON mapping_schedules (scheduled_date);
CREATE INDEX mapping_schedules_assigned_idx ON mapping_schedules (assigned_to, scheduled_date);

CREATE TRIGGER mapping_schedules_set_updated_at
  BEFORE UPDATE ON mapping_schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

Query aplikasi:

```sql
-- Daftar jadwal (admin)
SELECT s.id, s.office_id, o.name AS office_name, s.area, s.scheduled_date,
       s.assigned_to, u.name AS assigned_name, s.status
FROM mapping_schedules s
JOIN offices o ON o.id = s.office_id
LEFT JOIN users u ON u.id = s.assigned_to
ORDER BY s.scheduled_date DESC, o.name;

-- Jadwal hari ini untuk teknisi ($1 = id teknisi). Jadwal tanpa penugasan terlihat semua teknisi.
SELECT s.id, s.office_id, o.name AS office_name, s.area, s.status
FROM mapping_schedules s
JOIN offices o ON o.id = s.office_id
WHERE s.scheduled_date = (now() AT TIME ZONE 'Asia/Jakarta')::date
  AND s.status <> 'dibatalkan'
  AND (s.assigned_to IS NULL OR s.assigned_to = $1)
ORDER BY o.name;

-- Buat jadwal
INSERT INTO mapping_schedules (office_id, area, scheduled_date, assigned_to, created_by)
VALUES ($1, $2, $3, $4, $5)
RETURNING id;

-- Ubah jadwal
UPDATE mapping_schedules
SET office_id = $2, area = $3, scheduled_date = $4, assigned_to = $5, status = $6
WHERE id = $1;

-- Batalkan jadwal (dianjurkan dibanding hapus agar jejak tetap ada)
UPDATE mapping_schedules SET status = 'dibatalkan' WHERE id = $1;

-- Hapus jadwal
DELETE FROM mapping_schedules WHERE id = $1;
```

---

## 6. Modul Scan dan Hasil Mapping (`mapping_results`)

```sql
CREATE TABLE mapping_results (
  id             serial PRIMARY KEY,
  schedule_id    integer      NOT NULL REFERENCES mapping_schedules (id),
  asset_id       integer      REFERENCES assets (id),  -- NULL jika not_found/multiple belum dipilih
  scanned_sn     text         NOT NULL,
  result         match_result NOT NULL,
  scanned_by     integer      NOT NULL REFERENCES users (id),
  scanned_at     timestamptz  NOT NULL DEFAULT now(),
  label_attached boolean      NOT NULL DEFAULT false
);

CREATE INDEX mapping_results_schedule_idx ON mapping_results (schedule_id);
CREATE INDEX mapping_results_asset_idx    ON mapping_results (asset_id);
CREATE INDEX mapping_results_date_idx     ON mapping_results (scanned_at);
```

Query aplikasi:

```sql
-- Pencocokan SN (POST /api/scan/match).
-- Hasil: 0 baris = not_found, 1 baris = found, lebih dari 1 = multiple.
SELECT id, kind, eq, serial_number, ref, status, kondisi, asset_code, office_id
FROM assets
WHERE upper(serial_number) = upper(trim($1));
```

```sql
-- Simpan hasil mapping (POST /api/mapping-results), satu transaksi.
BEGIN;

INSERT INTO mapping_results (schedule_id, asset_id, scanned_sn, result, scanned_by, label_attached)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id;

-- Jika found: tandai aset sudah termapping dan catat label
UPDATE assets
SET mapping_status = 'sudah',
    label_status   = CASE WHEN $6 THEN 'terpasang'::label_status ELSE label_status END,
    label_code     = COALESCE($7, label_code)
WHERE id = $2;

-- Jika not_found: tandai di aset yang dituju bila ada (asset_id tidak NULL)
-- UPDATE assets SET mapping_status = 'tidak_ditemukan' WHERE id = $2;

-- Jadwal otomatis berjalan setelah scan pertama
UPDATE mapping_schedules
SET status = 'berjalan'
WHERE id = $1 AND status = 'terjadwal';

COMMIT;
```

```sql
-- Riwayat scan satu jadwal
SELECT r.id, r.scanned_sn, r.result, a.eq, u.name AS scanned_by,
       r.scanned_at, r.label_attached
FROM mapping_results r
LEFT JOIN assets a ON a.id = r.asset_id
JOIN users u ON u.id = r.scanned_by
WHERE r.schedule_id = $1
ORDER BY r.scanned_at DESC;
```

---

## 7. Modul Dashboard dan Laporan

```sql
-- Kartu ringkasan dashboard admin
SELECT count(*)                                           AS total,
       count(*) FILTER (WHERE mapping_status = 'sudah')           AS sudah,
       count(*) FILTER (WHERE mapping_status = 'belum')           AS belum,
       count(*) FILTER (WHERE mapping_status = 'tidak_ditemukan') AS tidak_ditemukan
FROM assets;

-- Progres per kantor (GET /api/dashboard/progress)
SELECT o.id, o.name,
       count(a.id)                                         AS total,
       count(a.id) FILTER (WHERE a.mapping_status = 'sudah') AS done,
       CASE WHEN count(a.id) = 0 THEN 0
            ELSE round(100.0 * count(a.id) FILTER (WHERE a.mapping_status = 'sudah') / count(a.id))
       END                                                 AS percent
FROM offices o
LEFT JOIN assets a ON a.office_id = o.id
GROUP BY o.id, o.name
ORDER BY o.name;

-- Laporan hasil mapping dalam rentang tanggal ($1 = awal, $2 = akhir, inklusif)
SELECT r.scanned_at, o.name AS office_name, a.eq, r.scanned_sn, r.result,
       u.name AS scanned_by, r.label_attached
FROM mapping_results r
JOIN mapping_schedules s ON s.id = r.schedule_id
JOIN offices o           ON o.id = s.office_id
JOIN users u             ON u.id = r.scanned_by
LEFT JOIN assets a       ON a.id = r.asset_id
WHERE (r.scanned_at AT TIME ZONE 'Asia/Jakarta')::date BETWEEN $1 AND $2
ORDER BY r.scanned_at DESC;

-- Rekap hasil per kantor dalam rentang tanggal
SELECT o.name,
       count(*) FILTER (WHERE r.result = 'found')     AS found,
       count(*) FILTER (WHERE r.result = 'not_found') AS not_found,
       count(*) FILTER (WHERE r.result = 'multiple')  AS multiple
FROM mapping_results r
JOIN mapping_schedules s ON s.id = r.schedule_id
JOIN offices o           ON o.id = s.office_id
WHERE (r.scanned_at AT TIME ZONE 'Asia/Jakarta')::date BETWEEN $1 AND $2
GROUP BY o.name
ORDER BY o.name;
```

---

## 8. Modul Notifikasi Telegram (`notification_logs`)

```sql
CREATE TABLE notification_logs (
  id      serial PRIMARY KEY,
  type    text        NOT NULL,         -- 'jadwal_harian' | 'hasil_harian'
  payload jsonb       NOT NULL DEFAULT '{}',
  sent_at timestamptz NOT NULL DEFAULT now(),
  success boolean     NOT NULL
);

CREATE INDEX notification_logs_type_idx ON notification_logs (type, sent_at DESC);
```

Query aplikasi:

```sql
-- Data pesan pagi: jadwal hari ini
SELECT o.name AS office_name, s.area, u.name AS assigned_name
FROM mapping_schedules s
JOIN offices o ON o.id = s.office_id
LEFT JOIN users u ON u.id = s.assigned_to
WHERE s.scheduled_date = (now() AT TIME ZONE 'Asia/Jakarta')::date
  AND s.status <> 'dibatalkan'
ORDER BY o.name;

-- Data pesan sore: ringkasan hasil hari ini
SELECT count(*) FILTER (WHERE result = 'found')     AS found,
       count(*) FILTER (WHERE result = 'not_found') AS not_found,
       count(*) FILTER (WHERE result = 'multiple')  AS multiple
FROM mapping_results
WHERE (scanned_at AT TIME ZONE 'Asia/Jakarta')::date = (now() AT TIME ZONE 'Asia/Jakarta')::date;

-- Perubahan status aset hari ini
SELECT a.eq, h.field, h.old_value, h.new_value
FROM asset_history h
JOIN assets a ON a.id = h.asset_id
WHERE (h.changed_at AT TIME ZONE 'Asia/Jakarta')::date = (now() AT TIME ZONE 'Asia/Jakarta')::date
ORDER BY h.changed_at;

-- Catat pengiriman
INSERT INTO notification_logs (type, payload, success) VALUES ($1, $2, $3);
```

---

## 9. Reset (hanya untuk development)

Menghapus semua tabel dan tipe. **Jangan dijalankan di database produksi.**

```sql
DROP TABLE IF EXISTS notification_logs, mapping_results, asset_history,
                     mapping_schedules, assets, offices, users CASCADE;
DROP FUNCTION IF EXISTS log_asset_changes(), set_updated_at();
DROP TYPE IF EXISTS user_role, asset_kind, mapping_status, label_status, area_type,
                    schedule_status, match_result, history_field;
```
