import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import worker from '../src/index.js';

const ORIGIN = 'https://goodframe.com.au';

class MemoryBucket {
  constructor() {
    this.objects = new Map();
  }
  async head(key) {
    return this.objects.has(key) ? { key } : null;
  }
  async put(key, body, options) {
    this.objects.set(key, {
      body: await new Response(body).arrayBuffer(),
      type: options.httpMetadata.contentType
    });
  }
  async get(key) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      body: stored.body,
      httpEtag: '"test-etag"',
      writeHttpMetadata(headers) {
        headers.set('Content-Type', stored.type);
      }
    };
  }
}

function env(bucket = new MemoryBucket()) {
  return {
    ARTWORK_BUCKET: bucket,
    ALLOWED_ORIGINS: ORIGIN,
    STRIPE_MODE: 'test',
    STRIPE_TEST_SECRET_KEY: 'sk_test_example',
    SITE_BASE_URL: ORIGIN
  };
}

function uploadRequest(fields, fileType, fileName) {
  const form = new FormData();
  form.append('file', new Blob(['image bytes'], { type: fileType }), fileName);
  Object.entries(fields).forEach(([key, value]) => form.append(key, value));
  return new Request('https://worker.example/artwork/upload', {
    method: 'POST', headers: { Origin: ORIGIN }, body: form
  });
}

test('stores and retrieves an original and thumbnail using exact returned keys', async () => {
  const bucket = new MemoryBucket();
  const testEnv = env(bucket);
  const originalResponse = await worker.fetch(uploadRequest({
    kind: 'original', uploadId: '504616'
  }, 'image/jpeg', 'artwork.jpg'), testEnv);
  assert.equal(originalResponse.status, 200);
  const original = await originalResponse.json();
  assert.match(original.objectKey, /^uploads\/\d{4}\/\d{2}\/\d{2}\/504616\/original\.jpg$/);

  const thumbnailResponse = await worker.fetch(uploadRequest({
    kind: 'thumbnail', uploadId: '504616', originalObjectKey: original.objectKey
  }, 'image/png', 'thumbnail.png'), testEnv);
  const thumbnail = await thumbnailResponse.json();
  assert.equal(thumbnail.objectKey, original.objectKey.replace('/original.jpg', '/thumbnail.png'));
  assert.equal(bucket.objects.size, 2);

  const retrieval = await worker.fetch(new Request(thumbnail.url, {
    headers: { Origin: ORIGIN }
  }), testEnv);
  assert.equal(retrieval.status, 200);
  assert.equal(retrieval.headers.get('Content-Type'), 'image/png');
});

test('checkout sends complete artwork keys to Stripe metadata', async () => {
  const originalFetch = globalThis.fetch;
  let stripeBody;
  let stripeAuthorization;
  globalThis.fetch = async (_url, options) => {
    stripeBody = new URLSearchParams(options.body);
    stripeAuthorization = options.headers.Authorization;
    return Response.json({ id: 'cs_test_1', url: 'https://checkout.stripe.test/session' });
  };
  try {
    const originalObjectKey = 'uploads/2026/08/25/504616/original.jpg';
    const thumbnailObjectKey = 'uploads/2026/08/25/504616/thumbnail.png';
    const response = await worker.fetch(new Request('https://worker.example/create-checkout-session', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{
        uniqueCode: '504616', size: '210x297mm', quantity: 1,
        originalObjectKey, thumbnailObjectKey
      }] })
    }), env());
    assert.equal(response.status, 200);
    assert.equal((await response.clone().json()).stripeMode, 'test');
    assert.equal(stripeAuthorization, 'Bearer sk_test_example');
    assert.equal(stripeBody.get('metadata[stripe_mode]'), 'test');
    assert.match(stripeBody.get('custom_text[submit][message]'), /TEST MODE/);
    assert.equal(stripeBody.get('line_items[0][price_data][product_data][metadata][original_object_key]'), originalObjectKey);
    assert.equal(stripeBody.get('line_items[0][price_data][product_data][metadata][thumbnail_object_key]'), thumbnailObjectKey);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('test mode refuses live and legacy Stripe keys', async () => {
  const response = await worker.fetch(new Request('https://worker.example/health', {
    headers: { Origin: ORIGIN }
  }), {
    ...env(),
    STRIPE_TEST_SECRET_KEY: '',
    STRIPE_SECRET_KEY: 'sk_live_legacy',
    STRIPE_LIVE_SECRET_KEY: 'sk_live_current'
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok:true,
    stripeMode:'test',
    checkoutConfigured:false,
    fulfilmentEnabled:false
  });
});

test('production keeps the existing live secret fallback during migration', async () => {
  const response = await worker.fetch(new Request('https://worker.example/health'), {
    STRIPE_MODE:'live',
    STRIPE_SECRET_KEY:'sk_live_existing_configuration',
    STRIPE_WEBHOOK_SECRET:'whsec_existing_configuration',
    SITE_BASE_URL:'https://goodframe.com.au',
    ALLOWED_ORIGINS:'https://goodframe.com.au'
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    ok:true,
    stripeMode:'live',
    checkoutConfigured:true,
    fulfilmentEnabled:true
  });
  assert.doesNotMatch(JSON.stringify(body), /existing_configuration/);
});

test('test mode rejects live Checkout session IDs before contacting Stripe', async () => {
  const originalFetch = globalThis.fetch;
  let stripeCalled = false;
  globalThis.fetch = async () => {
    stripeCalled = true;
    return Response.json({});
  };
  try {
    const response = await worker.fetch(new Request(
      'https://worker.example/checkout-session-status?session_id=cs_live_example',
      { headers: { Origin: ORIGIN } }
    ), env());
    assert.equal(response.status, 400);
    assert.equal(stripeCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function createStripeSignature(body, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

test('test webhooks are acknowledged without fulfilment or notifications', async () => {
  const webhookSecret = 'whsec_test_example';
  const body = JSON.stringify({
    id:'evt_test_no_fulfilment',
    type:'checkout.session.completed',
    livemode:false,
    data:{ object:{ id:'cs_test_example', metadata:{} } }
  });
  const testEnv = {
    ...env(),
    STRIPE_TEST_WEBHOOK_SECRET:webhookSecret,
    RESEND_API_KEY:'must-not-be-used'
  };
  const response = await worker.fetch(new Request('https://worker.example/stripe-webhook', {
    method:'POST',
    headers:{ 'Stripe-Signature':createStripeSignature(body, webhookSecret) },
    body
  }), testEnv);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    received:true,
    testMode:true,
    fulfilmentSuppressed:true
  });
  assert.equal(testEnv.ARTWORK_BUCKET.objects.size, 0);
});

test('webhooks reject events from the opposite Stripe mode', async () => {
  const webhookSecret = 'whsec_test_example';
  const body = JSON.stringify({
    id:'evt_live_wrong_environment',
    type:'checkout.session.completed',
    livemode:true,
    data:{ object:{ id:'cs_live_example', metadata:{} } }
  });
  const response = await worker.fetch(new Request('https://worker.example/stripe-webhook', {
    method:'POST',
    headers:{ 'Stripe-Signature':createStripeSignature(body, webhookSecret) },
    body
  }), {
    ...env(),
    STRIPE_TEST_WEBHOOK_SECRET:webhookSecret
  });
  assert.equal(response.status, 400);
});

test('checkout charges $90 for a Tiny Frame with eight pictures plus $10 shipping', async () => {
  const originalFetch = globalThis.fetch;
  let stripeBody;
  globalThis.fetch = async (_url, options) => {
    stripeBody = new URLSearchParams(options.body);
    return Response.json({ id: 'cs_test_tiny', url: 'https://checkout.stripe.test/tiny' });
  };
  try {
    const bucket = new MemoryBucket();
    const uploadReference = 'tf_abcdef0123456789abcdef0123456789';
    bucket.objects.set(`tiny-frame-uploads/${uploadReference}.json`, { body:new ArrayBuffer(0), type:'application/json' });
    const response = await worker.fetch(new Request('https://worker.example/create-checkout-session', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{
        productType: 'tiny_frame_8_pictures',
        uniqueCode: '804208',
        size: '80x80mm',
        frameColour: 'Oak',
        quantity: 1,
        uploadReference
      }] })
    }), env(bucket));
    assert.equal(response.status, 200);
    assert.equal(stripeBody.get('line_items[0][price_data][product_data][name]'), 'Tiny Frame + 8 Pictures');
    assert.equal(stripeBody.get('line_items[0][price_data][unit_amount]'), '9000');
    assert.equal(
      stripeBody.get('line_items[0][price_data][product_data][metadata][upload_reference]'),
      uploadReference
    );
    assert.equal(stripeBody.has('line_items[0][price_data][product_data][metadata][artwork_object_keys]'), false);
    assert.equal(stripeBody.get('line_items[1][price_data][product_data][name]'), 'Shipping');
    assert.equal(stripeBody.get('line_items[1][price_data][unit_amount]'), '1000');
    assert.equal(
      Number(stripeBody.get('line_items[0][price_data][unit_amount]')) +
        Number(stripeBody.get('line_items[1][price_data][unit_amount]')),
      10000
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkout charges $70 for Frame Only plus $10 shipping', async () => {
  const originalFetch = globalThis.fetch;
  let stripeBody;
  globalThis.fetch = async (_url, options) => {
    stripeBody = new URLSearchParams(options.body);
    return Response.json({ id: 'cs_test_frame_only', url: 'https://checkout.stripe.test/frame-only' });
  };
  try {
    const response = await worker.fetch(new Request('https://worker.example/create-checkout-session', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{
        productType: 'tiny-frame',
        uniqueCode: '804209',
        size: '80x80mm',
        frameColor: 'Walnut',
        orderType: 'Frame Only',
        quantity: 1,
        artworkObjectKeys: []
      }] })
    }), env());
    assert.equal(response.status, 200);
    assert.equal(stripeBody.get('line_items[0][price_data][unit_amount]'), '7000');
    assert.equal(stripeBody.get('line_items[1][price_data][product_data][name]'), 'Shipping');
    assert.equal(stripeBody.get('line_items[1][price_data][unit_amount]'), '1000');
    assert.equal(
      Number(stripeBody.get('line_items[0][price_data][unit_amount]')) +
        Number(stripeBody.get('line_items[1][price_data][unit_amount]')),
      8000
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkout adds the $10 shipping line only once for multiple Tiny Frames', async () => {
  const originalFetch = globalThis.fetch;
  let stripeBody;
  globalThis.fetch = async (_url, options) => {
    stripeBody = new URLSearchParams(options.body);
    return Response.json({ id: 'cs_test_multiple', url: 'https://checkout.stripe.test/multiple' });
  };
  try {
    const bucket = new MemoryBucket();
    const uploadReference = 'tf_1234567890abcdef1234567890abcdef';
    bucket.objects.set(`tiny-frame-uploads/${uploadReference}.json`, { body:new ArrayBuffer(0), type:'application/json' });
    const response = await worker.fetch(new Request('https://worker.example/create-checkout-session', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [
        { productType:'tiny_frame_only', uniqueCode: '804210', size: '80x80mm', frameColour:'Oak', quantity: 1 },
        { productType:'tiny_frame_8_pictures', uniqueCode: '804211', size: '80x80mm', frameColour:'Walnut', quantity: 1, uploadReference }
      ] })
    }), env(bucket));
    assert.equal(response.status, 200);
    assert.equal(stripeBody.get('line_items[0][price_data][unit_amount]'), '7000');
    assert.equal(stripeBody.get('line_items[1][price_data][unit_amount]'), '9000');
    assert.equal(stripeBody.get('line_items[2][price_data][product_data][name]'), 'Shipping');
    assert.equal(stripeBody.get('line_items[2][price_data][unit_amount]'), '1000');
    assert.equal(stripeBody.has('line_items[3][price_data][product_data][name]'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
