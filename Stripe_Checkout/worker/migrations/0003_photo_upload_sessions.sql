CREATE TABLE IF NOT EXISTS photo_upload_sessions (
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
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS photo_upload_sessions_cleanup_idx
  ON photo_upload_sessions(status, updated_at);

CREATE INDEX IF NOT EXISTS photo_upload_sessions_stripe_idx
  ON photo_upload_sessions(stripe_checkout_session_id);
