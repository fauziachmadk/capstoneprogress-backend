# ERD Backend Caps2Tone

Skema dieksekusi melalui migrasi 001 sampai 008. Struktur bisnis mengikuti `queryDB.md`: ID integer, enum PostgreSQL, dan kolom `kondisi`. UUID lama disimpan dalam kolom `legacy_id` pada tabel entitas. `offices.area` ditambahkan untuk memvalidasi kecocokan area jadwal dengan kantor. `sessions` dan `schema_migrations` mendukung sesi yang dapat dicabut serta migrasi terkontrol.

```mermaid
erDiagram
    users ||--o{ technician_areas : serves
    users ||--o{ sessions : authenticates
    users ||--o{ mapping_schedules : assigned_or_created
    users ||--o{ mapping_results : scans
    users ||--o{ asset_history : changes
    users ||--o{ mapping_rejections : rejects
    assets ||--o{ mapping_rejections : rejected
    equipment_types ||--o{ asset_inventory : typed
    inventory_sites ||--o{ asset_inventory : located
    offices ||--o{ assets : contains
    offices ||--o{ mapping_schedules : schedules
    assets o|--o{ assets : chassis_modules
    assets o|--o{ mapping_results : matched_asset
    assets ||--o{ asset_history : tracks
    mapping_schedules ||--o{ mapping_results : records
    users {
        integer id PK
        uuid legacy_id UK
        text name
        text username UK
        text password_hash
        user_role role
        area_type_array areas
        boolean is_active
        timestamptz updated_at
        text telegram_chat_id
        employee_type employee_type
        approval_status approval_status
        timestamptz decided_at
        integer decided_by FK
        timestamptz created_at
    }
    technician_areas {
        integer user_id PK,FK
        area_type area PK
    }
    sessions {
        text token_hash PK
        integer user_id FK
        timestamptz expires_at
        timestamptz created_at
    }
    offices {
        integer id PK
        uuid legacy_id UK
        text code UK
        text name
        text address
        area_type area
        timestamptz created_at
    }
    assets {
        integer id PK
        uuid legacy_id UK
        asset_kind kind
        integer parent_id FK
        text eq UK
        text serial_number
        text ref
        text status
        text kondisi
        text asset_code
        integer office_id FK
        mapping_status mapping_status
        label_status label_status
        text label_code
        text photo_url
        timestamptz created_at
        timestamptz updated_at
    }
    mapping_schedules {
        integer id PK
        uuid legacy_id UK
        integer office_id FK
        area_type area
        date scheduled_date
        integer assigned_to FK
        schedule_status status
        integer created_by FK
        timestamptz created_at
        timestamptz updated_at
    }
    mapping_results {
        integer id PK
        uuid legacy_id UK
        integer schedule_id FK
        integer asset_id FK
        text scanned_sn
        match_result result
        integer scanned_by FK
        timestamptz scanned_at
        boolean label_attached
        text photo_url
    }
    mapping_rejections {
        integer id PK
        integer asset_id FK
        text reason
        integer rejected_by FK
        timestamptz rejected_at
        timestamptz resolved_at
    }
    equipment_types {
        integer id PK
        text name UK
        text category
        text object_type
        text manufacturer
        text model
        text part_number
    }
    inventory_sites {
        integer id PK
        text code UK
        text name
        text functional_location UK
        text description
        text territory
        text regional_code
        text district_code
        text cost_center
        text maintenance_plant
        text work_center
    }
    asset_inventory {
        integer id PK
        text equipment_id UK
        text inventory_number UK
        text nka UK
        date nka_acq_date
        text serial_number
        text superior_equipment
        text remarks
        integer type_id FK
        integer site_id FK
    }
    asset_history {
        integer id PK
        uuid legacy_id UK
        integer asset_id FK
        history_field field
        text old_value
        text new_value
        integer changed_by FK
        timestamptz changed_at
    }
    notification_logs {
        integer id PK
        uuid legacy_id UK
        text type
        text dedupe_key UK
        jsonb payload
        timestamptz sent_at
        boolean success
        timestamptz attempted_at
    }
    schema_migrations {
        text name PK
        text checksum
        timestamptz applied_at
    }
```

`assets.serial_number` diindeks dan tidak unik. EQ dan kode kantor unik. Partial unique index `(office_id, scheduled_date)` berlaku untuk jadwal `terjadwal`/`berjalan`. FK mengikuti kebijakan migrasi: parent aset dan penugasan memakai SET NULL, riwayat aset memakai CASCADE, sesi memakai CASCADE, dan referensi lain mempertahankan pembatasan penghapusan. Aset tidak memiliki endpoint penghapusan fisik.

Trigger memvalidasi induk chassis sekantor dan penugasan teknisi sesuai area. Trigger audit mewajibkan `app.user_id` untuk perubahan ref/status/kondisi, lalu mencatat nilai lama/baru di transaksi yang sama. Driver mengatur actor lewat `set_config(..., true)` sehingga tidak bocor ke transaksi lain pada pool.

## Migrasi 004 sampai 008

| Migrasi | Isi |
|---|---|
| `004_asset_inventory` | Master inventaris dari CSV: `equipment_types`, `inventory_sites`, `asset_inventory`. Berdiri sendiri; `Equipment ID` di sini berbeda dari `assets.eq` dan `inventory_sites` berbeda dari `offices`. `superior_equipment` hanya teks karena induknya tidak ada di dataset. |
| `005_employee_registration` | `users.employee_type` (karyawan/magang), `approval_status` (menunggu/aktif/ditolak/nonaktif), `decided_at`, `decided_by`. Trigger `users_sync_approval` menjaga `is_active` tetap sinkron dengan `approval_status`. |
| `006_mapping_rejections` | Penolakan hasil mapping oleh admin. Satu baris per penolakan; penolakan aktif adalah baris dengan `resolved_at IS NULL` (paling banyak satu per aset) dan diselesaikan saat teknisi memetakan ulang. |
| `007_photo_urls` | `photo_url` di `assets` (foto terbaru) dan `mapping_results` (bukti per scan). Hanya URL Cloudinary proyek ini yang diterima API. |
| `008_inventory_link` | `offices.site_id` dan `assets.inventory_id` (nullable, unik) menautkan kantor ke `inventory_sites` dan aset kerja ke `asset_inventory`. Master adalah sumber kebenaran; `npm run inventory:sync` mengisi kantor (satu per site) dan aset kerja (satu per baris master, `eq` = Equipment ID). |
