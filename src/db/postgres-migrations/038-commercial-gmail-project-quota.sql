-- Keep standard Gmail API traffic below the published daily project billing
-- threshold. Reservations are conservative: an attempted request is counted
-- even when its network outcome is uncertain.
CREATE TABLE commercial_provider_daily_quotas (
 provider TEXT NOT NULL,
 day_utc DATE NOT NULL,
 reserved_units BIGINT NOT NULL CHECK(reserved_units>=0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(provider,day_utc)
);
