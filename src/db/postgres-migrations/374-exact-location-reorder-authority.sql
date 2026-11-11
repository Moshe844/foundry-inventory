ALTER TABLE stockchief_runtime.location_reorder_rules
  ALTER COLUMN ceiling TYPE numeric(20,6),
  ADD COLUMN profile_key text,
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  ADD COLUMN taught_recommendation_id text REFERENCES planning_recommendations(id) ON DELETE SET NULL;
