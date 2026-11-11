DO $$
DECLARE existing text;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT existing FROM pg_constraint
 WHERE conrelid='stockchief_runtime.agent_time_samples'::regclass AND conname='agent_time_samples_activity_check';
 ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
 EXECUTE 'ALTER TABLE stockchief_runtime.agent_time_samples ADD CONSTRAINT agent_time_samples_activity_check CHECK (('||existing||') OR activity IN (''receiving-document'',''supplier-direct-purchase'',''supplier-direct-dispatch'',''delivery-comparison''))';
END $$;
