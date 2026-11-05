-- Preserve the indexed ISO instant exactly, without entering an exception
-- subtransaction or changing session settings for every movement timestamp.
CREATE OR REPLACE FUNCTION stockchief_movement_instant(input_time text) RETURNS timestamptz
 LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
BEGIN
 IF input_time !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([Tt ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?([Zz]|[+-][0-9]{2}(:?[0-9]{2})?)?)?$' THEN
  RETURN NULL;
 END IF;
 IF input_time ~ '[Tt ].*([Zz]|[+-][0-9]{2}(:?[0-9]{2})?)$' THEN
  IF NOT pg_catalog.pg_input_is_valid(input_time,'pg_catalog.timestamptz') THEN RETURN NULL; END IF;
  RETURN input_time::timestamptz;
 END IF;
 IF NOT pg_catalog.pg_input_is_valid(input_time,'pg_catalog.timestamp') THEN RETURN NULL; END IF;
 RETURN input_time::timestamp AT TIME ZONE 'UTC';
END $$;
ALTER FUNCTION stockchief_movement_instant(text) RESET ALL;
