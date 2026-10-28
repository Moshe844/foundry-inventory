-- Optional product images are isolated from quantities, prices and accounting.
CREATE TABLE product_images (
  item_id text PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  image_bytes bytea NOT NULL CHECK(octet_length(image_bytes) BETWEEN 1 AND 4194304),
  content_hash text NOT NULL,
  updated_at text NOT NULL,
  updated_by_user_id text NOT NULL REFERENCES users(id)
);
CREATE INDEX product_images_workspace ON product_images(workspace_id);
