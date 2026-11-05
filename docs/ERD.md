# ERD Backend Caps2Tone

Skema dieksekusi melalui migrasi 001, 002, dan 003. Struktur bisnis mengikuti `queryDB.md`: ID integer, enum PostgreSQL, dan kolom `kondisi`. UUID lama disimpan dalam kolom `legacy_id` pada tabel entitas. `offices.area` ditambahkan untuk memvalidasi kecocokan area jadwal dengan kantor. `sessions` dan `schema_migrations` mendukung sesi yang dapat dicabut serta migrasi terkontrol.

```mermaid
erDiagram
    users ||--o{ technician_areas : serves
    users ||--o{ sessions : authenticates
    users ||--o{ mapping_schedules : assigned_or_created
    users ||--o{ mapping_results : scans
    users ||--o{ asset_history : changes
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
