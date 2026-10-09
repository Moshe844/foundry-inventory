ALTER TABLE import_plans DROP CONSTRAINT IF EXISTS import_plans_source_kind_check;
ALTER TABLE import_plans ADD CONSTRAINT import_plans_source_kind_check
  CHECK (source_kind IN ('xlsx','csv','pdf','image','paste'));
