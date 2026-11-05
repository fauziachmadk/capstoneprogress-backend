-- Align the existing UUID schema with queryDB.md without resetting any rows.
-- UUIDs remain available in legacy_id; all existing foreign keys are remapped.
LOCK TABLE users, technician_areas, sessions, offices, assets, mapping_schedules,
  mapping_results, asset_history, notification_logs IN ACCESS EXCLUSIVE MODE;

CREATE TYPE user_role AS ENUM ('admin', 'teknisi');
CREATE TYPE asset_kind AS ENUM ('chassis', 'module');
CREATE TYPE mapping_status AS ENUM ('sudah', 'belum', 'tidak_ditemukan');
CREATE TYPE label_status AS ENUM ('terpasang', 'belum');
CREATE TYPE area_type AS ENUM ('grobogan', 'solo');
CREATE TYPE schedule_status AS ENUM ('terjadwal', 'berjalan', 'selesai', 'dibatalkan');
CREATE TYPE match_result AS ENUM ('found', 'not_found', 'multiple');
CREATE TYPE history_field AS ENUM ('ref', 'status', 'kondisi');

ALTER TABLE assets DISABLE TRIGGER assets_audit;
ALTER TABLE assets DISABLE TRIGGER assets_parent;
ALTER TABLE mapping_schedules DISABLE TRIGGER schedules_validate;

CREATE TEMP TABLE migration_foreign_keys ON COMMIT DROP AS
SELECT conrelid::regclass::text AS table_name, conname AS name,
  pg_get_constraintdef(oid) AS definition
FROM pg_constraint WHERE contype='f' AND conrelid IN
  ('technician_areas'::regclass,'sessions'::regclass,'assets'::regclass,
   'mapping_schedules'::regclass,'mapping_results'::regclass,'asset_history'::regclass);

CREATE TEMP TABLE migration_id_map (
  table_name text NOT NULL, legacy_id uuid NOT NULL, new_id integer NOT NULL,
  PRIMARY KEY(table_name,legacy_id)
) ON COMMIT DROP;

DO $$
DECLARE entry record; target text;
BEGIN
  FOR entry IN SELECT * FROM migration_foreign_keys LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',entry.table_name,entry.name);
  END LOOP;
  ALTER TABLE technician_areas DROP CONSTRAINT technician_areas_pkey;
  ALTER TABLE assets DROP CONSTRAINT assets_check;
  FOREACH target IN ARRAY ARRAY['users','offices','assets','mapping_schedules','mapping_results','asset_history','notification_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN id_integer serial',target);
    EXECUTE format('INSERT INTO migration_id_map SELECT %L,id,id_integer FROM %I',target,target);
  END LOOP;
END $$;

CREATE FUNCTION migration_integer_id(target text, old_id uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE mapped integer;
BEGIN
  IF old_id IS NULL THEN RETURN NULL; END IF;
  SELECT new_id INTO mapped FROM migration_id_map WHERE table_name=target AND legacy_id=old_id;
  IF mapped IS NULL THEN RAISE EXCEPTION 'Unmapped reference in %',target; END IF;
  RETURN mapped;
END $$;

DO $$
DECLARE entry record; target text;
BEGIN
  FOR entry IN SELECT * FROM (VALUES
    ('technician_areas','user_id','users'),('sessions','user_id','users'),
    ('assets','parent_id','assets'),('assets','office_id','offices'),
    ('mapping_schedules','office_id','offices'),('mapping_schedules','assigned_to','users'),
    ('mapping_schedules','created_by','users'),('mapping_results','schedule_id','mapping_schedules'),
    ('mapping_results','asset_id','assets'),('mapping_results','scanned_by','users'),
    ('asset_history','asset_id','assets'),('asset_history','changed_by','users')
  ) AS refs(table_name,column_name,target_table) LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE integer USING migration_integer_id(%L,%I)',
      entry.table_name,entry.column_name,entry.target_table,entry.column_name);
  END LOOP;
  FOREACH target IN ARRAY ARRAY['users','offices','assets','mapping_schedules','mapping_results','asset_history','notification_logs'] LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',target,target||'_pkey');
    EXECUTE format('ALTER TABLE %I RENAME COLUMN id TO legacy_id',target);
    EXECUTE format('ALTER TABLE %I RENAME COLUMN id_integer TO id',target);
    EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY(id)',target);
    EXECUTE format('ALTER TABLE %I ADD UNIQUE(legacy_id)',target);
  END LOOP;
  ALTER TABLE technician_areas ADD PRIMARY KEY(user_id,area);
  FOR entry IN SELECT * FROM migration_foreign_keys LOOP
    IF entry.name='assets_parent_id_fkey' THEN
      entry.definition := 'FOREIGN KEY(parent_id) REFERENCES assets(id) ON DELETE SET NULL';
    ELSIF entry.name='asset_history_asset_id_fkey' THEN
      entry.definition := 'FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE';
    ELSIF entry.name='mapping_schedules_assigned_to_fkey' THEN
      entry.definition := 'FOREIGN KEY(assigned_to) REFERENCES users(id) ON DELETE SET NULL';
    END IF;
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',entry.table_name,entry.name,entry.definition);
  END LOOP;
END $$;
DROP FUNCTION migration_integer_id(text,uuid);

ALTER TABLE assets ADD CONSTRAINT assets_parent_not_self CHECK(parent_id IS NULL OR parent_id<>id);
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users DROP CONSTRAINT users_username_check;
ALTER TABLE users ALTER COLUMN role TYPE user_role USING role::user_role;
ALTER TABLE users ADD COLUMN areas area_type[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN is_active boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
UPDATE users u SET areas=ARRAY(SELECT area::area_type FROM technician_areas WHERE user_id=u.id ORDER BY area);
ALTER TABLE users DROP CONSTRAINT users_username_key;
CREATE UNIQUE INDEX users_username_key ON users(lower(username));
ALTER TABLE technician_areas DROP CONSTRAINT technician_areas_area_check;
ALTER TABLE technician_areas ALTER COLUMN area TYPE area_type USING area::area_type;
ALTER TABLE offices DROP CONSTRAINT offices_area_check;
ALTER TABLE offices ALTER COLUMN area DROP NOT NULL;
ALTER TABLE offices ALTER COLUMN area TYPE area_type USING area::area_type;
ALTER TABLE offices ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE assets RENAME COLUMN condition TO kondisi;
UPDATE assets SET ref=coalesce(ref,''),status=coalesce(status,''),kondisi=coalesce(kondisi,''),asset_code=coalesce(asset_code,'');
ALTER TABLE assets ALTER COLUMN ref SET DEFAULT '', ALTER COLUMN ref SET NOT NULL;
ALTER TABLE assets ALTER COLUMN status SET DEFAULT '', ALTER COLUMN status SET NOT NULL;
ALTER TABLE assets ALTER COLUMN kondisi SET DEFAULT '', ALTER COLUMN kondisi SET NOT NULL;
ALTER TABLE assets ALTER COLUMN asset_code SET DEFAULT '', ALTER COLUMN asset_code SET NOT NULL;
ALTER TABLE assets DROP CONSTRAINT assets_kind_check;
ALTER TABLE assets ALTER COLUMN kind TYPE asset_kind USING kind::asset_kind;
ALTER TABLE assets ADD CONSTRAINT assets_parent_module CHECK(parent_id IS NULL OR kind='module');
ALTER TABLE assets DROP CONSTRAINT assets_mapping_status_check;
ALTER TABLE assets ALTER COLUMN mapping_status DROP DEFAULT;
ALTER TABLE assets ALTER COLUMN mapping_status TYPE mapping_status USING mapping_status::mapping_status;
ALTER TABLE assets ALTER COLUMN mapping_status SET DEFAULT 'belum';
ALTER TABLE assets DROP CONSTRAINT assets_label_status_check;
ALTER TABLE assets ALTER COLUMN label_status DROP DEFAULT;
ALTER TABLE assets ALTER COLUMN label_status TYPE label_status USING label_status::label_status;
ALTER TABLE assets ALTER COLUMN label_status SET DEFAULT 'belum';
CREATE INDEX assets_serial_number_upper_idx ON assets(upper(serial_number));
CREATE INDEX assets_mapping_status_idx ON assets(office_id,mapping_status);

ALTER TABLE mapping_schedules DROP CONSTRAINT mapping_schedules_area_check;
ALTER TABLE mapping_schedules ALTER COLUMN area TYPE area_type USING area::area_type;
-- Rebuild the partial index after converting the underlying enum column.
DROP INDEX schedules_active_office_date_idx;
ALTER TABLE mapping_schedules DROP CONSTRAINT mapping_schedules_status_check;
ALTER TABLE mapping_schedules ALTER COLUMN status DROP DEFAULT;
ALTER TABLE mapping_schedules ALTER COLUMN status TYPE schedule_status USING status::schedule_status;
ALTER TABLE mapping_schedules ALTER COLUMN status SET DEFAULT 'terjadwal';
ALTER TABLE mapping_schedules ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE mapping_schedules ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX schedules_active_office_date_idx ON mapping_schedules(office_id,scheduled_date) WHERE status IN ('terjadwal','berjalan');
CREATE INDEX mapping_schedules_date_idx ON mapping_schedules(scheduled_date);
ALTER TABLE mapping_results DROP CONSTRAINT mapping_results_result_check;
ALTER TABLE mapping_results DROP CONSTRAINT mapping_results_check;
ALTER TABLE mapping_results DROP CONSTRAINT mapping_results_check1;
ALTER TABLE mapping_results DROP CONSTRAINT mapping_results_check2;
ALTER TABLE mapping_results ALTER COLUMN result TYPE match_result USING result::match_result;
ALTER TABLE mapping_results ADD CHECK(result<>'not_found' OR NOT label_attached);
ALTER TABLE mapping_results ADD CHECK(result<>'found' OR asset_id IS NOT NULL);
ALTER TABLE mapping_results ADD CHECK(NOT label_attached OR asset_id IS NOT NULL);
CREATE INDEX mapping_results_date_idx ON mapping_results(scanned_at);
ALTER TABLE asset_history DROP CONSTRAINT asset_history_field_check;
UPDATE asset_history SET field='kondisi' WHERE field='condition';
ALTER TABLE asset_history ALTER COLUMN field TYPE history_field USING field::history_field;
UPDATE asset_history SET old_value=coalesce(old_value,''),new_value=coalesce(new_value,'');
ALTER TABLE asset_history ALTER COLUMN old_value SET DEFAULT '', ALTER COLUMN old_value SET NOT NULL;
ALTER TABLE asset_history ALTER COLUMN new_value SET DEFAULT '', ALTER COLUMN new_value SET NOT NULL;
ALTER TABLE asset_history ALTER COLUMN changed_by DROP NOT NULL;
ALTER TABLE notification_logs ALTER COLUMN payload SET DEFAULT '{}';
ALTER TABLE notification_logs ALTER COLUMN sent_at SET DEFAULT now();
-- Keep nullable sent_at and dedupe fields to distinguish queued/failed sends.
CREATE INDEX notification_logs_type_idx ON notification_logs(type,sent_at DESC);

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER assets_set_updated_at BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER mapping_schedules_set_updated_at BEFORE UPDATE ON mapping_schedules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER assets_audit ON assets;
ALTER FUNCTION audit_asset_changes() RENAME TO log_asset_changes;
CREATE OR REPLACE FUNCTION log_asset_changes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field_name text; old_text text; new_text text; actor integer;
BEGIN
  FOREACH field_name IN ARRAY ARRAY['ref','status','kondisi'] LOOP
    old_text:=to_jsonb(OLD)->>field_name; new_text:=to_jsonb(NEW)->>field_name;
    IF old_text IS DISTINCT FROM new_text THEN
      actor:=coalesce(nullif(current_setting('app.user_id',true),''),nullif(current_setting('app.actor_id',true),''))::integer;
      IF actor IS NULL THEN RAISE EXCEPTION 'Actor wajib untuk perubahan aset' USING ERRCODE='23514'; END IF;
      INSERT INTO asset_history(asset_id,field,old_value,new_value,changed_by) VALUES(NEW.id,field_name::history_field,old_text,new_text,actor);
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER assets_log_changes AFTER UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION log_asset_changes();

CREATE OR REPLACE FUNCTION validate_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM offices WHERE id=NEW.office_id AND (area IS NULL OR area=NEW.area) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Area kantor tidak sesuai' USING ERRCODE='23514'; END IF;
  IF NEW.assigned_to IS NOT NULL THEN
    PERFORM 1 FROM users WHERE id=NEW.assigned_to AND role='teknisi' AND is_active AND NEW.area=ANY(areas) FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Teknisi tidak melayani area' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;

-- Preserve compatibility with technician_areas while users.areas is canonical.
CREATE FUNCTION sync_user_areas() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth()>1 THEN RETURN NEW; END IF;
  DELETE FROM technician_areas WHERE user_id=NEW.id;
  INSERT INTO technician_areas(user_id,area) SELECT NEW.id,unnest(NEW.areas) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER users_sync_areas AFTER INSERT OR UPDATE OF areas ON users FOR EACH ROW EXECUTE FUNCTION sync_user_areas();
CREATE FUNCTION sync_technician_areas() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target integer;
BEGIN
  IF TG_OP='DELETE' THEN target:=OLD.user_id; ELSE target:=NEW.user_id; END IF;
  IF pg_trigger_depth()=1 THEN
    UPDATE users SET areas=ARRAY(SELECT area FROM technician_areas WHERE user_id=target ORDER BY area) WHERE id=target;
    IF TG_OP='UPDATE' AND OLD.user_id<>NEW.user_id THEN
      UPDATE users SET areas=ARRAY(SELECT area FROM technician_areas WHERE user_id=OLD.user_id ORDER BY area) WHERE id=OLD.user_id;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER technician_areas_sync AFTER INSERT OR UPDATE OR DELETE ON technician_areas FOR EACH ROW EXECUTE FUNCTION sync_technician_areas();
ALTER TABLE assets ENABLE TRIGGER assets_parent;
ALTER TABLE mapping_schedules ENABLE TRIGGER schedules_validate;
