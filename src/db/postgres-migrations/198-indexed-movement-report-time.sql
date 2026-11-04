-- Keep immutable movement history intact. Parse absolute ISO dates in a fixed
-- calendar context and index the result, rather than casting every old row for
-- each selected-date chart. Ambiguous/invalid legacy dates remain reviewable.
CREATE FUNCTION stockchief_movement_instant(input_time text) RETURNS timestamptz
 LANGUAGE plpgsql IMMUTABLE STRICT SET TimeZone='UTC' SET DateStyle='ISO, YMD' AS $$
BEGIN
 IF input_time !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([Tt ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?([Zz]|[+-][0-9]{2}(:?[0-9]{2})?)?)?$' THEN
  RETURN NULL;
 END IF;
 RETURN input_time::timestamptz;
EXCEPTION WHEN data_exception THEN RETURN NULL;
END $$;
CREATE INDEX idx_movements_workspace_instant ON movements(workspace_id,stockchief_movement_instant(occurred_at)) INCLUDE(occurred_at,quantity_delta);
ANALYZE movements;
