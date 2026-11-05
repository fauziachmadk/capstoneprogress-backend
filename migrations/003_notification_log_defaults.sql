-- Keep queryDB.md's INSERT(type,payload,success) usable for administrative logs.
-- Cron explicitly supplies stable keys for delivery deduplication.
ALTER TABLE notification_logs ALTER COLUMN dedupe_key SET DEFAULT gen_random_uuid()::text;
