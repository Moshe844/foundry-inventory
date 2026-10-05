CREATE TABLE stockchief_runtime.authentication_attempts (
  scope TEXT NOT NULL CHECK (scope IN ('EMAIL', 'IP')),
  fingerprint TEXT NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  blocked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, fingerprint)
);

CREATE INDEX authentication_attempts_expiry
  ON stockchief_runtime.authentication_attempts(updated_at, blocked_until);
