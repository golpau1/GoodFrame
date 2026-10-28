CREATE TABLE photo_upload_sessions_replacement (
  upload_session_id TEXT PRIMARY KEY CHECK (upload_session_id GLOB 'tf_[0-9a-f]*' AND length(upload_session_id) = 35),
  cart_item_id TEXT NOT NULL CHECK (cart_item_id GLOB 'ci_[0-9a-f]*' AND length(cart_item_id) = 35),
  upload_token_hash TEXT NOT NULL CHECK (length(upload_token_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('draft', 'finalized', 'checkout_pending', 'expired', 'paid')),
  selection_json TEXT NOT NULL DEFAULT '[]',
  selection_version INTEGER NOT NULL DEFAULT 0 CHECK (selection_version >= 0),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  photo_set_count INTEGER NOT NULL DEFAULT 1 CHECK (photo_set_count >= 0),
  frame_colour TEXT,
  snapshot_json TEXT,
  product_codes_json TEXT NOT NULL DEFAULT '[]',
  stripe_checkout_session_id TEXT,
  checkout_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  storage_folder TEXT
    CHECK (
      storage_folder IS NULL OR (
        length(storage_folder) BETWEEN 17 AND 29 AND
        instr(storage_folder, '/') = 0
      )
    ),
  product_code TEXT
    CHECK (
      product_code IS NULL OR (
        length(product_code) = 5 AND
        product_code GLOB '[1-9][0-9][0-9][0-9][0-9]'
      )
    )
);

INSERT INTO photo_upload_sessions_replacement (
  upload_session_id,
  cart_item_id,
  upload_token_hash,
  status,
  selection_json,
  selection_version,
  state_version,
  photo_set_count,
  frame_colour,
  snapshot_json,
  product_codes_json,
  stripe_checkout_session_id,
  checkout_expires_at,
  created_at,
  updated_at,
  storage_folder,
  product_code
)
SELECT
  upload_session_id,
  cart_item_id,
  upload_token_hash,
  status,
  selection_json,
  selection_version,
  state_version,
  photo_set_count,
  frame_colour,
  snapshot_json,
  product_codes_json,
  stripe_checkout_session_id,
  checkout_expires_at,
  created_at,
  updated_at,
  storage_folder,
  product_code
FROM photo_upload_sessions;

DROP TABLE photo_upload_sessions;
ALTER TABLE photo_upload_sessions_replacement RENAME TO photo_upload_sessions;

CREATE INDEX photo_upload_sessions_cleanup_idx
  ON photo_upload_sessions(status, updated_at);

CREATE INDEX photo_upload_sessions_stripe_idx
  ON photo_upload_sessions(stripe_checkout_session_id);

CREATE UNIQUE INDEX photo_upload_sessions_storage_folder_idx
  ON photo_upload_sessions(storage_folder)
  WHERE storage_folder IS NOT NULL;

CREATE UNIQUE INDEX photo_upload_sessions_product_code_idx
  ON photo_upload_sessions(product_code)
  WHERE product_code IS NOT NULL;
