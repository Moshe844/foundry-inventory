-- Workload measurements, not CPU claims or fabricated provider prices.
CREATE TABLE commercial_resource_measurements (
 id TEXT PRIMARY KEY,
 account_id TEXT REFERENCES accounts(id),
 workspace_id TEXT REFERENCES workspaces(id),
 resource_id TEXT NOT NULL,
 runtime_kind TEXT NOT NULL CHECK(runtime_kind IN ('web','worker')),
 operation TEXT NOT NULL,
 started_at TIMESTAMPTZ NOT NULL,
 finished_at TIMESTAMPTZ NOT NULL,
 elapsed_microseconds BIGINT NOT NULL CHECK(elapsed_microseconds>=0),
 database_microseconds BIGINT NOT NULL CHECK(database_microseconds>=0),
 database_queries BIGINT NOT NULL CHECK(database_queries>=0),
 attribution TEXT NOT NULL CHECK(attribution IN ('TENANT','SHARED','MIXED')),
 outcome TEXT NOT NULL,
 CHECK(finished_at>=started_at)
);
CREATE INDEX commercial_resource_period ON commercial_resource_measurements(resource_id,started_at,account_id);
