ALTER TABLE product_codes ADD COLUMN frame_colour TEXT;
ALTER TABLE product_codes ADD COLUMN unit_amount INTEGER CHECK (unit_amount IS NULL OR unit_amount > 0);
ALTER TABLE product_codes ADD COLUMN currency TEXT CHECK (currency IS NULL OR currency = 'aud');
