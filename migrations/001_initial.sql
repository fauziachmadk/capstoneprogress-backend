CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  username text NOT NULL UNIQUE CHECK (username = lower(btrim(username))),
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'teknisi')),
  telegram_chat_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE technician_areas (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  area text NOT NULL CHECK (area IN ('grobogan', 'solo')),
  PRIMARY KEY (user_id, area)
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);
CREATE TABLE offices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code = upper(btrim(code))),
  name text NOT NULL,
  address text NOT NULL DEFAULT '',
  area text NOT NULL CHECK (area IN ('grobogan', 'solo'))
);
CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('chassis', 'module')),
  parent_id uuid REFERENCES assets(id) ON DELETE RESTRICT,
  eq text NOT NULL UNIQUE,
  serial_number text NOT NULL CHECK (serial_number = upper(btrim(serial_number)) AND length(serial_number) > 0),
  ref text,
  status text,
  condition text,
  asset_code text,
  office_id uuid NOT NULL REFERENCES offices(id) ON DELETE RESTRICT,
  mapping_status text NOT NULL DEFAULT 'belum' CHECK (mapping_status IN ('belum', 'sudah', 'tidak_ditemukan')),
  label_status text NOT NULL DEFAULT 'belum' CHECK (label_status IN ('belum', 'terpasang')),
  label_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_id IS NULL OR (kind = 'module' AND parent_id <> id))
);
CREATE INDEX assets_serial_number_idx ON assets(serial_number);
CREATE INDEX assets_office_idx ON assets(office_id);
CREATE INDEX assets_parent_idx ON assets(parent_id);
CREATE TABLE mapping_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id uuid NOT NULL REFERENCES offices(id) ON DELETE RESTRICT,
  area text NOT NULL CHECK (area IN ('grobogan', 'solo')),
  scheduled_date date NOT NULL,
  assigned_to uuid REFERENCES users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'terjadwal' CHECK (status IN ('terjadwal', 'berjalan', 'selesai', 'dibatalkan')),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX schedules_active_office_date_idx ON mapping_schedules(office_id, scheduled_date)
  WHERE status IN ('terjadwal', 'berjalan');
CREATE INDEX schedules_assigned_date_idx ON mapping_schedules(assigned_to, scheduled_date);
CREATE TABLE mapping_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES mapping_schedules(id) ON DELETE RESTRICT,
  asset_id uuid REFERENCES assets(id) ON DELETE RESTRICT,
  scanned_sn text NOT NULL,
  result text NOT NULL CHECK (result IN ('found', 'not_found', 'multiple')),
  scanned_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  label_attached boolean NOT NULL DEFAULT false,
  CHECK (result <> 'not_found' OR asset_id IS NULL),
  CHECK (result <> 'found' OR asset_id IS NOT NULL),
  CHECK (NOT label_attached OR asset_id IS NOT NULL)
);
CREATE INDEX mapping_results_schedule_idx ON mapping_results(schedule_id, scanned_at);
CREATE INDEX mapping_results_asset_idx ON mapping_results(asset_id);
CREATE TABLE asset_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  field text NOT NULL CHECK (field IN ('ref', 'status', 'condition')),
  old_value text,
  new_value text,
  changed_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX asset_history_asset_idx ON asset_history(asset_id, changed_at);
CREATE TABLE notification_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  sent_at timestamptz,
  success boolean NOT NULL DEFAULT false,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION audit_asset_changes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field_name text; old_text text; new_text text; actor uuid;
BEGIN
  FOREACH field_name IN ARRAY ARRAY['ref', 'status', 'condition'] LOOP
    old_text := to_jsonb(OLD)->>field_name;
    new_text := to_jsonb(NEW)->>field_name;
    IF old_text IS DISTINCT FROM new_text THEN
      actor := nullif(current_setting('app.actor_id', true), '')::uuid;
      IF actor IS NULL THEN RAISE EXCEPTION 'Actor wajib untuk perubahan aset' USING ERRCODE = '23514'; END IF;
      INSERT INTO asset_history(asset_id, field, old_value, new_value, changed_by)
        VALUES(NEW.id, field_name, old_text, new_text, actor);
    END IF;
  END LOOP;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER assets_audit BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION audit_asset_changes();

CREATE FUNCTION validate_asset_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    PERFORM 1 FROM assets WHERE id = NEW.parent_id AND kind = 'chassis' AND office_id = NEW.office_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Chassis induk harus sekantor' USING ERRCODE = '23514'; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM assets WHERE parent_id = NEW.id AND (NEW.kind <> 'chassis' OR office_id <> NEW.office_id)) THEN
    RAISE EXCEPTION 'Chassis masih memiliki modul terkait' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assets_parent BEFORE INSERT OR UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION validate_asset_parent();

CREATE FUNCTION validate_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM offices WHERE id = NEW.office_id AND area = NEW.area FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Area kantor tidak sesuai' USING ERRCODE = '23514'; END IF;
  IF NEW.assigned_to IS NOT NULL THEN
    PERFORM 1 FROM users u JOIN technician_areas t ON t.user_id=u.id
      WHERE u.id=NEW.assigned_to AND u.role='teknisi' AND t.area=NEW.area FOR SHARE OF u, t;
    IF NOT FOUND THEN RAISE EXCEPTION 'Teknisi tidak melayani area' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER schedules_validate BEFORE INSERT OR UPDATE ON mapping_schedules FOR EACH ROW EXECUTE FUNCTION validate_schedule();
