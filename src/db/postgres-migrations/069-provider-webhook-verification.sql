-- Provider application setup belongs to the deployment operator, not to any
-- merchant tenant. A received challenge proves no provider or business event.
CREATE TABLE stockchief_runtime.provider_webhook_challenges (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  app_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox','production')),
  code_hash TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  expires_at BIGINT NOT NULL,
  UNIQUE (provider,app_id,environment,code_hash)
);
CREATE INDEX provider_webhook_challenges_scope ON stockchief_runtime.provider_webhook_challenges
  (provider,app_id,environment,received_at DESC);
CREATE INDEX provider_webhook_challenges_expiry ON stockchief_runtime.provider_webhook_challenges(expires_at);
