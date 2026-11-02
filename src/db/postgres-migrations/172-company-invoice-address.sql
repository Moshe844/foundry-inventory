CREATE TABLE workspace_company_profiles (
 workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 legal_name TEXT NOT NULL CHECK(length(legal_name) BETWEEN 1 AND 160),
 address_line1 TEXT NOT NULL DEFAULT '' CHECK(length(address_line1)<=160),
 address_line2 TEXT NOT NULL DEFAULT '' CHECK(length(address_line2)<=160),
 city TEXT NOT NULL DEFAULT '' CHECK(length(city)<=100),
 region TEXT NOT NULL DEFAULT '' CHECK(length(region)<=100),
 postal_code TEXT NOT NULL DEFAULT '' CHECK(length(postal_code)<=30),
 country TEXT NOT NULL DEFAULT '' CHECK(length(country)<=80),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
