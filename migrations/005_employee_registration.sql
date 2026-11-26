-- Pendaftaran mandiri karyawan dengan persetujuan admin (mengikuti Employee di frontend).
-- users.is_active tetap dipakai autentikasi; approval_status menjadi sumber status yang lebih rinci
-- dan trigger di bawah menjaga keduanya konsisten.

CREATE TYPE employee_type AS ENUM ('karyawan', 'magang');
CREATE TYPE approval_status AS ENUM ('menunggu', 'aktif', 'ditolak', 'nonaktif');

ALTER TABLE users ADD COLUMN employee_type employee_type NOT NULL DEFAULT 'karyawan';
ALTER TABLE users ADD COLUMN approval_status approval_status NOT NULL DEFAULT 'aktif';
ALTER TABLE users ADD COLUMN decided_at timestamptz;
ALTER TABLE users ADD COLUMN decided_by integer REFERENCES users(id) ON DELETE SET NULL;

-- Akun lama: yang nonaktif tetap nonaktif, sisanya aktif (default).
UPDATE users SET approval_status = 'nonaktif' WHERE NOT is_active;

CREATE INDEX users_pending_idx ON users(created_at) WHERE approval_status = 'menunggu';

CREATE FUNCTION sync_user_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- is_active=false tanpa approval_status eksplisit berarti nonaktif; selain itu approval_status menentukan.
    IF NEW.approval_status = 'aktif' AND NOT NEW.is_active THEN
      NEW.approval_status := 'nonaktif';
    ELSE
      NEW.is_active := (NEW.approval_status = 'aktif');
    END IF;
  ELSIF NEW.approval_status IS DISTINCT FROM OLD.approval_status THEN
    NEW.is_active := (NEW.approval_status = 'aktif');
  ELSIF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    IF NEW.is_active THEN
      NEW.approval_status := 'aktif';
    ELSIF OLD.approval_status = 'aktif' THEN
      NEW.approval_status := 'nonaktif';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_sync_approval BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION sync_user_approval();
