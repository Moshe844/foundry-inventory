-- Supported by PostgreSQL 17 and Render Postgres. Rank likely matches in the
-- database before applying a response limit; arbitrary prefix samples lose
-- valid typo matches as a catalogue grows.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS ix_items_active_name_trigrams ON items USING gin(name gin_trgm_ops) WHERE is_active=1;
CREATE INDEX IF NOT EXISTS ix_skus_active_code_trigrams ON skus USING gin(code gin_trgm_ops) WHERE is_active=1;
