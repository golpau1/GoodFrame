ALTER TABLE photo_upload_sessions
  ADD COLUMN product_code TEXT
    CHECK (
      product_code IS NULL OR (
        length(product_code) = 5 AND
        product_code GLOB '[1-9][0-9][0-9][0-9][0-9]'
      )
    );

CREATE UNIQUE INDEX IF NOT EXISTS photo_upload_sessions_product_code_idx
  ON photo_upload_sessions(product_code)
  WHERE product_code IS NOT NULL;
