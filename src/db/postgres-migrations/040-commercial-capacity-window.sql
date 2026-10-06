-- The one-minute capacity sampler scans only recent web measurements.
CREATE INDEX IF NOT EXISTS commercial_resource_web_recent
 ON commercial_resource_measurements(started_at,elapsed_microseconds)
 WHERE runtime_kind='web';
