-- Stock search finds products by name, base code, SKU code, barcode, variant
-- label, serial number or lot code. Name and SKU code already have trigram
-- indexes (131) and barcode an exact lookup; these cover the remaining fields
-- so every part of a search is an index lookup instead of a catalogue scan.
-- Partial on active rows, like 131, because archived rows are searched only on
-- request. Serial numbers and lot codes have no active flag.
CREATE INDEX IF NOT EXISTS ix_items_active_base_code_trigrams ON items USING gin(base_code gin_trgm_ops) WHERE is_active=1;
CREATE INDEX IF NOT EXISTS ix_skus_active_variant_label_trigrams ON skus USING gin(variant_label gin_trgm_ops) WHERE is_active=1;
CREATE INDEX IF NOT EXISTS ix_serial_units_serial_trigrams ON serial_units USING gin(serial gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_lots_code_trigrams ON lots USING gin(code gin_trgm_ops);
