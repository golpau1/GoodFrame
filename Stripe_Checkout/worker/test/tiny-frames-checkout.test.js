import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {
  buildLineItems,
  claimWebhookEvent,
  createStripePayload
} from '../src/index.js';

const uploadReference = 'tf_0123456789abcdef0123456789abcdef';

function frameOnly(overrides = {}) {
  return {
    productType: 'tiny_frame_only',
    uniqueCode: '123456',
    size: '80x80mm',
    frameColour: 'Oak',
    quantity: 1,
    price: 1,
    ...overrides
  };
}

function frameWithPictures(overrides = {}) {
  return {
    productType: 'tiny_frame_8_pictures',
    uniqueCode: '654321',
    size: '80x80mm',
    frameColour: 'Walnut',
    quantity: 1,
    uploadReference,
    price: 1,
    ...overrides
  };
}

test('Tiny Frame prices and shipping are authoritative on the Worker', () => {
  const lineItems = buildLineItems([
    frameOnly(),
    frameWithPictures(),
    { price_data: { product_data: { name: 'Shipping' } }, quantity: 99 }
  ]);

  assert.deepEqual(lineItems.map(item => item.unitAmount), [7000, 9000, 1000]);
  assert.equal(lineItems.at(-1).name, 'Shipping');
  assert.equal(lineItems.filter(item => item.name === 'Shipping').length, 1);
});

test('picture products require a valid upload reference', () => {
  assert.throws(
    () => buildLineItems([frameWithPictures({ uploadReference: '' })]),
    /completed picture upload reference/
  );
});

test('Stripe payload contains safe Tiny Frame metadata and storefront return URLs', () => {
  const payload = createStripePayload(
    buildLineItems([frameOnly(), frameWithPictures()]),
    'https://goodframe.com.au'
  );

  assert.equal(payload.get('line_items[0][price_data][unit_amount]'), '7000');
  assert.equal(payload.get('line_items[1][price_data][unit_amount]'), '9000');
  assert.equal(payload.get('line_items[2][price_data][unit_amount]'), '1000');
  assert.equal(payload.get('line_items[0][price_data][product_data][metadata][product_type]'), 'tiny_frame_only');
  assert.equal(payload.get('line_items[1][price_data][product_data][metadata][product_type]'), 'tiny_frame_8_pictures');
  assert.equal(payload.get('line_items[1][price_data][product_data][metadata][frame_colour]'), 'Walnut');
  assert.equal(payload.get('line_items[1][price_data][product_data][metadata][upload_reference]'), uploadReference);
  assert.equal(payload.get('metadata[upload_references]'), uploadReference);
  assert.equal(payload.get('success_url'), 'https://goodframe.com.au/?checkout=success&session_id={CHECKOUT_SESSION_ID}');
  assert.equal(payload.get('cancel_url'), 'https://goodframe.com.au/?checkout=cancelled#cart');
  assert.equal([...payload.keys()].some(key => key.includes('artwork_object_keys')), false);
});

test('artwork manifest endpoint verifies all eight uploads', async () => {
  const objectKeys = Array.from(
    { length: 8 },
    (_, index) => `uploads/2026/10/06/${100000 + index}/original.jpg`
  );
  const stored = new Map(objectKeys.map(key => [key, true]));
  const env = {
    ALLOWED_ORIGINS: 'http://127.0.0.1:4173',
    ARTWORK_BUCKET: {
      head: async key => stored.has(key) ? {} : null,
      put: async (key, value) => {
        stored.set(key, value);
        return {};
      }
    }
  };
  const request = new Request('http://worker.test/artwork/manifest', {
    method: 'POST',
    headers: {
      Origin: 'http://127.0.0.1:4173',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ uploadReference, artworkObjectKeys: objectKeys })
  });

  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:4173');
  assert.deepEqual(await response.json(), { uploadReference });
  assert.equal(stored.has(`tiny-frame-uploads/${uploadReference}.json`), true);
});

test('webhook event claims are idempotent', async () => {
  const stored = new Map();
  const env = {
    ARTWORK_BUCKET: {
      head: async key => stored.has(key) ? {} : null,
      put: async (key, value, options) => {
        if (options?.onlyIf?.etagDoesNotMatch === '*' && stored.has(key)) return null;
        stored.set(key, value);
        return {};
      }
    }
  };

  assert.equal(await claimWebhookEvent('evt_TinyFrames123', env), true);
  assert.equal(await claimWebhookEvent('evt_TinyFrames123', env), false);
});

