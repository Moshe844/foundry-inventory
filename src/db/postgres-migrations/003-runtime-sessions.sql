CREATE SCHEMA IF NOT EXISTS stockchief_runtime;

CREATE TABLE stockchief_runtime.sessions (
  sid TEXT PRIMARY KEY,
  expires_at BIGINT NOT NULL,
  data JSONB NOT NULL
);

CREATE INDEX sessions_expiry ON stockchief_runtime.sessions(expires_at);
