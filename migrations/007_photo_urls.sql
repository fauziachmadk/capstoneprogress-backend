-- URL foto validasi dari teknisi (disimpan di Cloudinary; hanya URL-nya yang disimpan di sini).
-- assets.photo_url = foto terbaru (Asset.photoUrl di frontend); mapping_results.photo_url = bukti per scan.
-- NULL berarti tidak ada foto.

ALTER TABLE assets ADD COLUMN photo_url text CHECK (photo_url IS NULL OR (btrim(photo_url) <> '' AND length(photo_url) <= 500));
ALTER TABLE mapping_results ADD COLUMN photo_url text CHECK (photo_url IS NULL OR (btrim(photo_url) <> '' AND length(photo_url) <= 500));
