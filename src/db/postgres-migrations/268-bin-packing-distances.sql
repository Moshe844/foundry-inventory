CREATE TABLE stockchief_runtime.bin_packing_distances (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  metres numeric(12,2) NOT NULL CHECK(metres>=0),
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,location_id)
);
