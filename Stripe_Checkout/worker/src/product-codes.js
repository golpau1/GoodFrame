const PRODUCT_CODE_MIN = 10000;
const PRODUCT_CODE_MAX = 99999;
const PRODUCT_CODE_CAPACITY = PRODUCT_CODE_MAX - PRODUCT_CODE_MIN + 1;
const PRODUCT_CODE_WARNING_REMAINING = 9000;
const MAX_ALLOCATION_ATTEMPTS = 256;

class ProductCodeError extends Error {}
class ProductCodeCapacityError extends ProductCodeError {}

function normalizeCartItemId(value) {
  const id = String(value || '').trim().toLowerCase();
  return /^ci_[a-f0-9]{32}$/.test(id) ? id : '';
}

function normalizeCheckoutRequestId(value) {
  const id = String(value || '').trim().toLowerCase();
  return /^co_[a-f0-9]{32}$/.test(id) ? id : '';
}

function normalizeProductCode(value) {
  const code = String(value || '').trim();
  return /^[1-9][0-9]{4}$/.test(code) ? code : '';
}

function randomProductCode(randomValues = values => crypto.getRandomValues(values)) {
  const range = PRODUCT_CODE_CAPACITY;
  const maximumUnbiasedValue = Math.floor(0x100000000 / range) * range;
  const values = new Uint32Array(1);
  do {
    randomValues(values);
  } while (values[0] >= maximumUnbiasedValue);
  return String(PRODUCT_CODE_MIN + (values[0] % range));
}

function requireDatabase(database) {
  if (!database || typeof database.prepare !== 'function') {
    throw new ProductCodeError('Product code database is not configured');
  }
  return database;
}

async function first(database, sql, ...bindings) {
  return database.prepare(sql).bind(...bindings).first();
}

async function run(database, sql, ...bindings) {
  return database.prepare(sql).bind(...bindings).run();
}

async function all(database, sql, ...bindings) {
  const result = await database.prepare(sql).bind(...bindings).all();
  return Array.isArray(result?.results) ? result.results : [];
}

function changes(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

async function getProductCodeCapacity(database) {
  requireDatabase(database);
  const row = await first(database, 'SELECT COUNT(*) AS used FROM product_codes');
  const used = Number(row?.used || 0);
  const remaining = Math.max(0, PRODUCT_CODE_CAPACITY - used);
  return {
    used,
    remaining,
    capacity:PRODUCT_CODE_CAPACITY,
    low:remaining <= PRODUCT_CODE_WARNING_REMAINING,
    exhausted:remaining === 0
  };
}

function validateUnit(unit) {
  const cartItemId = normalizeCartItemId(unit?.cartItemId);
  const unitIndex = Number(unit?.unitIndex);
  const productType = String(unit?.productType || '').trim();
  const uploadSessionId = String(unit?.uploadReference || '').trim();
  if (!cartItemId || !Number.isInteger(unitIndex) || unitIndex < 0 || !productType) {
    throw new ProductCodeError('A product has an invalid durable identity');
  }
  return { cartItemId, unitIndex, productType, uploadSessionId };
}

function assertExistingUnitMatches(row, unit) {
  if (
    String(row.product_type) !== unit.productType ||
    String(row.upload_session_id || '') !== unit.uploadSessionId
  ) {
    throw new ProductCodeError('A cart product identity was reused for different product details');
  }
}

async function attachExistingCodeToRequest(database, row, unit, checkoutRequestId) {
  assertExistingUnitMatches(row, unit);
  const existingRequestId = String(row.checkout_request_id || '');
  if (!existingRequestId || existingRequestId === checkoutRequestId) return row;

  const previousRequest = await first(
    database,
    'SELECT stripe_checkout_session_id FROM checkout_requests WHERE request_id = ?',
    existingRequestId
  );
  if (previousRequest?.stripe_checkout_session_id) {
    throw new ProductCodeError('A cart product is already attached to another Stripe Checkout session');
  }
  await run(
    database,
    'UPDATE product_codes SET checkout_request_id = ? WHERE code = ? AND checkout_request_id = ?',
    checkoutRequestId,
    row.code,
    existingRequestId
  );
  return { ...row, checkout_request_id:checkoutRequestId };
}

async function reserveProductCodes(database, units, checkoutRequestId, options = {}) {
  requireDatabase(database);
  const requestId = normalizeCheckoutRequestId(checkoutRequestId);
  if (!requestId) throw new ProductCodeError('Checkout request identity is invalid');
  if (!Array.isArray(units) || units.length === 0 || units.length > 99) {
    throw new ProductCodeError('Checkout must contain between 1 and 99 physical products');
  }

  const capacityBefore = await getProductCodeCapacity(database);
  if (capacityBefore.remaining < units.length) {
    throw new ProductCodeCapacityError('The five-digit product code space is exhausted');
  }

  const output = [];
  for (const rawUnit of units) {
    const unit = validateUnit(rawUnit);
    let row = await first(
      database,
      'SELECT * FROM product_codes WHERE cart_item_id = ? AND unit_index = ?',
      unit.cartItemId,
      unit.unitIndex
    );
    if (row) {
      row = await attachExistingCodeToRequest(database, row, unit, requestId);
      output.push({ ...rawUnit, productCode:String(row.code) });
      continue;
    }

    let allocatedCode = '';
    for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt += 1) {
      const candidate = randomProductCode(options.randomValues);
      const result = await run(
        database,
        `INSERT OR IGNORE INTO product_codes
          (code, cart_item_id, unit_index, product_type, upload_session_id, checkout_request_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)`,
        candidate,
        unit.cartItemId,
        unit.unitIndex,
        unit.productType,
        unit.uploadSessionId || null,
        requestId,
        new Date().toISOString()
      );
      if (changes(result) > 0) {
        allocatedCode = candidate;
        break;
      }

      row = await first(
        database,
        'SELECT * FROM product_codes WHERE cart_item_id = ? AND unit_index = ?',
        unit.cartItemId,
        unit.unitIndex
      );
      if (row) {
        row = await attachExistingCodeToRequest(database, row, unit, requestId);
        allocatedCode = String(row.code);
        break;
      }
    }
    if (!allocatedCode) {
      const usedCodes = new Set((await all(database, 'SELECT code FROM product_codes')).map(item => String(item.code)));
      const randomStart = Number(randomProductCode(options.randomValues));
      for (let offset = 0; offset < PRODUCT_CODE_CAPACITY; offset += 1) {
        const candidate = String(PRODUCT_CODE_MIN + ((randomStart - PRODUCT_CODE_MIN + offset) % PRODUCT_CODE_CAPACITY));
        if (usedCodes.has(candidate)) continue;
        const result = await run(
          database,
          `INSERT OR IGNORE INTO product_codes
            (code, cart_item_id, unit_index, product_type, upload_session_id, checkout_request_id, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)`,
          candidate,
          unit.cartItemId,
          unit.unitIndex,
          unit.productType,
          unit.uploadSessionId || null,
          requestId,
          new Date().toISOString()
        );
        if (changes(result) > 0) {
          allocatedCode = candidate;
          break;
        }
      }
    }
    if (!allocatedCode) {
      throw new ProductCodeCapacityError('A unique five-digit product code could not be allocated');
    }
    output.push({ ...rawUnit, productCode:allocatedCode });
  }

  return {
    units:output,
    capacity:await getProductCodeCapacity(database)
  };
}

async function reserveCartProductCode(database, rawUnit, options = {}) {
  requireDatabase(database);
  const unit = validateUnit({ ...rawUnit, unitIndex:0, uploadReference:'' });
  const existing = await first(
    database,
    'SELECT * FROM product_codes WHERE cart_item_id = ? AND unit_index = 0',
    unit.cartItemId
  );
  if (existing) {
    if (String(existing.product_type) !== unit.productType) {
      throw new ProductCodeError('A cart product identity was reused for a different product');
    }
    return { productCode:String(existing.code), capacity:await getProductCodeCapacity(database) };
  }
  const provisionalRequestId = `co_${unit.cartItemId.slice(3)}`;
  const allocation = await reserveProductCodes(database, [{
    ...rawUnit,
    cartItemId:unit.cartItemId,
    unitIndex:0,
    productType:unit.productType,
    uploadReference:''
  }], provisionalRequestId, options);
  return { productCode:allocation.units[0].productCode, capacity:allocation.capacity };
}

async function attachProductPdf(database, code, cartItemId, objectKey) {
  requireDatabase(database);
  const normalizedCode = normalizeProductCode(code);
  const normalizedCartItemId = normalizeCartItemId(cartItemId);
  const key = String(objectKey || '');
  const currentKey = /^([1-9][0-9]{4})\/([1-9][0-9]{4})-print-sheet\.pdf$/.exec(key);
  const previousKey = /^tinyframes\/products\/([1-9][0-9]{4})\/print-sheet-([1-9][0-9]{4})\.pdf$/.exec(key);
  const keyMatch = currentKey || previousKey;
  if (!normalizedCode || !normalizedCartItemId || !keyMatch || keyMatch[1] !== normalizedCode || keyMatch[2] !== normalizedCode) {
    throw new ProductCodeError('Product PDF identity is invalid');
  }
  const row = await first(database, 'SELECT * FROM product_codes WHERE code = ?', normalizedCode);
  if (!row || row.cart_item_id !== normalizedCartItemId || Number(row.unit_index) !== 0) {
    throw new ProductCodeError('Product code does not belong to this cart product');
  }
  if (row.product_type !== 'tiny_frame_8_pictures') {
    throw new ProductCodeError('Product code is not for a picture product');
  }
  if (row.upload_session_id && row.upload_session_id !== key) {
    throw new ProductCodeError('A different PDF is already attached to this product code');
  }
  await run(
    database,
    'UPDATE product_codes SET upload_session_id = ? WHERE code = ? AND cart_item_id = ?',
    key,
    normalizedCode,
    normalizedCartItemId
  );
  return { ...row, upload_session_id:key };
}

async function beginCheckoutRequest(database, requestId, payloadHash, productCodes) {
  requireDatabase(database);
  const normalizedRequestId = normalizeCheckoutRequestId(requestId);
  if (!normalizedRequestId || !/^[a-f0-9]{64}$/.test(String(payloadHash || ''))) {
    throw new ProductCodeError('Checkout request identity is invalid');
  }
  const codes = Array.isArray(productCodes) ? productCodes.map(normalizeProductCode) : [];
  if (!codes.length || codes.some(code => !code) || new Set(codes).size !== codes.length) {
    throw new ProductCodeError('Checkout product codes are invalid');
  }
  await run(
    database,
    `INSERT OR IGNORE INTO checkout_requests
      (request_id, payload_hash, product_codes, status, created_at, updated_at)
     VALUES (?, ?, ?, 'creating', ?, ?)`,
    normalizedRequestId,
    payloadHash,
    JSON.stringify(codes),
    new Date().toISOString(),
    new Date().toISOString()
  );
  const request = await first(database, 'SELECT * FROM checkout_requests WHERE request_id = ?', normalizedRequestId);
  if (!request || request.payload_hash !== payloadHash || request.product_codes !== JSON.stringify(codes)) {
    throw new ProductCodeError('Checkout request identity was reused with different cart contents');
  }
  return request;
}

async function completeCheckoutRequest(database, requestId, stripeSession) {
  requireDatabase(database);
  const normalizedRequestId = normalizeCheckoutRequestId(requestId);
  const sessionId = String(stripeSession?.id || '');
  const sessionUrl = String(stripeSession?.url || '');
  if (!normalizedRequestId || !/^cs_(?:test|live)_[A-Za-z0-9]+$/.test(sessionId) || !sessionUrl) {
    throw new ProductCodeError('Stripe Checkout session details are invalid');
  }
  await run(
    database,
    `UPDATE checkout_requests
       SET stripe_checkout_session_id = ?, stripe_checkout_url = ?, status = 'open', updated_at = ?
     WHERE request_id = ?`,
    sessionId,
    sessionUrl,
    new Date().toISOString(),
    normalizedRequestId
  );
  await run(
    database,
    `UPDATE product_codes
       SET stripe_checkout_session_id = ?
     WHERE checkout_request_id = ?`,
    sessionId,
    normalizedRequestId
  );
}

async function markProductCodesPaid(database, session) {
  requireDatabase(database);
  const sessionId = String(session?.id || '');
  if (!/^cs_live_[A-Za-z0-9]+$/.test(sessionId)) {
    throw new ProductCodeError('A live Stripe Checkout session is required');
  }
  const paymentIntentId = String(session?.payment_intent || '');
  const paidAt = new Date().toISOString();
  await run(
    database,
    `UPDATE product_codes
       SET status = 'paid', stripe_payment_intent_id = ?, paid_at = ?
     WHERE stripe_checkout_session_id = ? AND status != 'paid'`,
    paymentIntentId || null,
    paidAt,
    sessionId
  );
  await run(
    database,
    `UPDATE checkout_requests
       SET status = 'paid', updated_at = ?
     WHERE stripe_checkout_session_id = ?`,
    paidAt,
    sessionId
  );
}

async function findProductCode(database, code) {
  requireDatabase(database);
  const normalizedCode = normalizeProductCode(code);
  if (!normalizedCode) throw new ProductCodeError('Product code must contain exactly five digits');
  return first(database, 'SELECT * FROM product_codes WHERE code = ?', normalizedCode);
}

export {
  PRODUCT_CODE_CAPACITY,
  PRODUCT_CODE_WARNING_REMAINING,
  ProductCodeCapacityError,
  ProductCodeError,
  attachProductPdf,
  beginCheckoutRequest,
  completeCheckoutRequest,
  findProductCode,
  getProductCodeCapacity,
  markProductCodesPaid,
  normalizeCartItemId,
  normalizeCheckoutRequestId,
  normalizeProductCode,
  randomProductCode,
  reserveCartProductCode,
  reserveProductCodes
};
