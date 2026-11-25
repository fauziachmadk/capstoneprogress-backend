-- Master inventaris perangkat (sumber: data_dummy_1000_baris.csv, gaya ekspor SAP PM).
-- Berdiri sendiri: tidak merujuk assets/offices. Equipment ID di sini berbeda dari assets.eq,
-- dan inventory_sites berbeda dari offices.
-- Runner migrasi sudah membungkus file ini dalam satu transaksi.

CREATE TABLE equipment_types (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (btrim(name) <> ''),
  category text NOT NULL DEFAULT '',
  object_type text NOT NULL DEFAULT '',
  manufacturer text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  part_number text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_sites (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code = upper(btrim(code)) AND code <> ''),
  name text NOT NULL,
  functional_location text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  territory text NOT NULL DEFAULT '',
  regional_code text NOT NULL DEFAULT '',
  regional_name text NOT NULL DEFAULT '',
  district_code text NOT NULL DEFAULT '',
  district_name text NOT NULL DEFAULT '',
  cost_center text NOT NULL DEFAULT '',
  maintenance_plant text NOT NULL DEFAULT '',
  work_center text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE asset_inventory (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  equipment_id text NOT NULL UNIQUE CHECK (btrim(equipment_id) <> ''),
  inventory_number text NOT NULL UNIQUE,
  nka text NOT NULL UNIQUE,
  nka_acq_date date,
  -- SN sengaja tidak unik, mengikuti aturan assets.
  serial_number text NOT NULL CHECK (serial_number = upper(btrim(serial_number)) AND serial_number <> ''),
  -- Hanya teks: induk tidak ada di dataset, sehingga belum bisa menjadi foreign key.
  superior_equipment text NOT NULL DEFAULT '',
  remarks text NOT NULL DEFAULT '',
  type_id integer NOT NULL REFERENCES equipment_types(id) ON DELETE RESTRICT,
  site_id integer NOT NULL REFERENCES inventory_sites(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX asset_inventory_serial_idx ON asset_inventory(serial_number);
CREATE INDEX asset_inventory_type_idx ON asset_inventory(type_id);
CREATE INDEX asset_inventory_site_idx ON asset_inventory(site_id);
CREATE INDEX asset_inventory_superior_idx ON asset_inventory(superior_equipment) WHERE superior_equipment <> '';

-- set_updated_at() dibuat di migrasi 002.
CREATE TRIGGER equipment_types_set_updated_at BEFORE UPDATE ON equipment_types FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER inventory_sites_set_updated_at BEFORE UPDATE ON inventory_sites FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER asset_inventory_set_updated_at BEFORE UPDATE ON asset_inventory FOR EACH ROW EXECUTE FUNCTION set_updated_at();
