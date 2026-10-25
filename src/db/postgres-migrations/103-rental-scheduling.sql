CREATE TABLE custody_bookings (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), agreement_id text NOT NULL REFERENCES custody_agreements(id),
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, time_zone text NOT NULL, buffer_minutes integer NOT NULL DEFAULT 0 CHECK(buffer_minutes BETWEEN 0 AND 43200),
 status text NOT NULL DEFAULT 'CONFIRMED' CHECK(status IN ('CONFIRMED','CANCELLED','COMPLETED')), revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_by_user_id text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(ends_at>starts_at), UNIQUE(workspace_id,agreement_id)
);
CREATE TABLE custody_booking_lines (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), booking_id text NOT NULL REFERENCES custody_bookings(id),
 custody_line_id text NOT NULL REFERENCES custody_lines(id), sku_id text NOT NULL REFERENCES skus(id), location_id text NOT NULL REFERENCES locations(id),
 quantity bigint NOT NULL CHECK(quantity>0), return_dependent boolean NOT NULL DEFAULT false, UNIQUE(workspace_id,booking_id,custody_line_id)
);
CREATE INDEX custody_booking_calendar ON custody_bookings(workspace_id,status,starts_at,ends_at);
CREATE INDEX custody_booking_position ON custody_booking_lines(workspace_id,sku_id,location_id,booking_id);
