PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS checkout_requests (
  request_id TEXT PRIMARY KEY CHECK (request_id GLOB 'co_[0-9a-f]*' AND length(request_id) = 35),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  product_codes TEXT NOT NULL,
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_checkout_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('creating', 'open', 'paid')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_codes (
  code TEXT PRIMARY KEY CHECK (code GLOB '[1-9][0-9][0-9][0-9][0-9]'),
  cart_item_id TEXT NOT NULL CHECK (cart_item_id GLOB 'ci_[0-9a-f]*' AND length(cart_item_id) = 35),
  unit_index INTEGER NOT NULL CHECK (unit_index >= 0),
  product_type TEXT NOT NULL,
  upload_session_id TEXT,
  checkout_request_id TEXT,
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'paid')),
  created_at TEXT NOT NULL,
  paid_at TEXT,
  UNIQUE (cart_item_id, unit_index)
);

CREATE INDEX IF NOT EXISTS product_codes_checkout_request_idx
  ON product_codes(checkout_request_id);

CREATE INDEX IF NOT EXISTS product_codes_stripe_session_idx
  ON product_codes(stripe_checkout_session_id);

CREATE INDEX IF NOT EXISTS product_codes_payment_intent_idx
  ON product_codes(stripe_payment_intent_id);

CREATE INDEX IF NOT EXISTS product_codes_upload_session_idx
  ON product_codes(upload_session_id);
