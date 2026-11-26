-- Menautkan master inventaris ke tabel kerja. Master (inventory_sites, asset_inventory) menjadi sumber kebenaran;
-- offices dan assets hanya menyimpan penunjuk ke master ditambah status kerja.
-- Kolom boleh NULL: kantor dan aset lama (mis. data DEMO) tetap valid tanpa master.
-- Runner migrasi sudah membungkus file ini dalam satu transaksi.

ALTER TABLE offices ADD COLUMN site_id integer UNIQUE REFERENCES inventory_sites(id) ON DELETE RESTRICT;
ALTER TABLE assets ADD COLUMN inventory_id integer UNIQUE REFERENCES asset_inventory(id) ON DELETE RESTRICT;
