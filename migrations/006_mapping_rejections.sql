-- Penolakan hasil mapping oleh admin (mengikuti Asset.rejection di frontend).
-- Satu baris per penolakan sehingga riwayatnya tetap ada. Penolakan "aktif" adalah baris
-- dengan resolved_at IS NULL; resolved_at diisi saat teknisi memetakan ulang aset tersebut.

CREATE TABLE mapping_rejections (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_id integer NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  rejected_by integer REFERENCES users(id) ON DELETE SET NULL,
  rejected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX mapping_rejections_asset_idx ON mapping_rejections(asset_id, rejected_at DESC);
-- Paling banyak satu penolakan aktif per aset.
CREATE UNIQUE INDEX mapping_rejections_open_idx ON mapping_rejections(asset_id) WHERE resolved_at IS NULL;
