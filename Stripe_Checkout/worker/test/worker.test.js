import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import worker from '../src/index.js';
import { createProductCodeDatabase } from './helpers/d1.js';

const ORIGIN = 'https://goodframe.com.au';

class MemoryBucket {
  constructor() {
    this.objects = new Map();
  }
  async head(key) {
    const stored = this.objects.get(key);
    return stored ? { key, customMetadata:stored.customMetadata } : null;
  }
  async put(key, body, options = {}) {
    if (options.onlyIf?.etagDoesNotMatch === '*' && this.objects.has(key)) return null;
    this.objects.set(key, {
      body: await new Response(body).arrayBuffer(),
      type: options.httpMetadata?.contentType || 'application/octet-stream',
      customMetadata:{ ...(options.customMetadata || {}) }
    });
    return { key };
  }
  async get(key) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      body: stored.body,
      customMetadata:{ ...stored.customMetadata },
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
    SITE_BASE_URL: ORIGIN,
    PRODUCT_CODES_DB:createProductCodeDatabase()
  };
}

function fakeJpeg(width = 1080, height = 1720) {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9
  ]);
}

async function seedPictureUpload(bucket, uploadReference) {
  const processedImages = [];
  for (let index = 1; index <= 8; index += 1) {
    const objectKey = `tinyframes/${uploadReference}/processed/${String(index).padStart(2, '0')}.jpg`;
    await bucket.put(objectKey, fakeJpeg(), {
      httpMetadata:{ contentType:'image/jpeg' },
      customMetadata:{ status:'pending' }
    });
    processedImages.push({ objectKey, contentType:'image/jpeg', size:23 });
  }
  await bucket.put(`tinyframes/${uploadReference}/manifest.json`, JSON.stringify({
    upload_session_id:uploadReference,
    frame_colour:'Oak',
    product_type:'frame_8_pictures',
    processed_images:processedImages,
    originals:[],
    files:[...processedImages],
    print_sheets:[],
    product_codes:[],
    status:'pending',
    uploaded_at:new Date().toISOString()
  }), { httpMetadata:{ contentType:'application/json' } });
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
      body: JSON.stringify({
        checkoutRequestId:'co_00000000000000000000000000000001',
        items: [{
        cartItemId:'ci_00000000000000000000000000000001', size: '210x297mm', quantity: 1,
        originalObjectKey, thumbnailObjectKey
      }] })
    }), env());
    assert.equal(response.status, 200);
    assert.equal((await response.clone().json()).stripeMode, 'test');
    assert.equal(stripeAuthorization, 'Bearer sk_test_example');
    assert.equal(stripeBody.get('metadata[stripe_mode]'), 'test');
    assert.match(stripeBody.get('custom_text[submit][message]'), /TEST MODE/);
    assert.match(stripeBody.get('line_items[0][price_data][product_data][metadata][product_code]'), /^[1-9][0-9]{4}$/);
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
    fulfilmentEnabled:false,
    productIdentificationConfigured:true
  });
});

test('production keeps the existing live secret fallback during migration', async () => {
  const response = await worker.fetch(new Request('https://worker.example/health'), {
    STRIPE_MODE:'live',
    STRIPE_SECRET_KEY:'sk_live_existing_configuration',
    STRIPE_WEBHOOK_SECRET:'whsec_existing_configuration',
    SITE_BASE_URL:'https://goodframe.com.au',
    ALLOWED_ORIGINS:'https://goodframe.com.au',
    PRODUCT_CODES_DB:createProductCodeDatabase()
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    ok:true,
    stripeMode:'live',
    checkoutConfigured:true,
    fulfilmentEnabled:true,
    productIdentificationConfigured:true
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
    await seedPictureUpload(bucket, uploadReference);
    const response = await worker.fetch(new Request('https://worker.example/create-checkout-session', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkoutRequestId:'co_00000000000000000000000000000002', items: [{
        productType: 'tiny_frame_8_pictures',
        cartItemId:'ci_00000000000000000000000000000002',
        size: '80x80mm',
        frameColour: 'Oak',
        quantity: 1,
        uploadReference
      }] })
    }), env(bucket));
    assert.equal(response.status, 200);
    const checkoutResult = await response.clone().json();
    const productCode = checkoutResult.productCodes[0];
    const manifest = JSON.parse(new TextDecoder().decode(
      bucket.objects.get(`tinyframes/${uploadReference}/manifest.json`).body
    ));
    assert.deepEqual(manifest.product_codes, [productCode]);
    assert.equal(manifest.print_sheets[0].filename, `${productCode}-print-sheet.pdf`);
    assert.equal(manifest.print_sheets[0].objectKey, `${productCode}/${productCode}-print-sheet.pdf`);
    const labelledPdf = new TextDecoder('latin1').decode(
      bucket.objects.get(manifest.print_sheets[0].objectKey).body
    );
    assert.match(labelledPdf, new RegExp(`\\(PRODUCT ${productCode}\\) Tj`));
    assert.equal(
      bucket.objects.get(`tinyframes/${uploadReference}/processed/01.jpg`).customMetadata.product_codes,
      productCode
    );
    assert.match(stripeBody.get('line_items[0][price_data][product_data][name]'), /^Tiny Frame \+ 8 Pictures · [1-9][0-9]{4}$/);
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
    return Response.json({ id: 'cs_test_frameonly1', url: 'https://checkout.stripe.test/frame-only' });
  };
  try {
    const response = await worker.fetch(new Request('https://worker.example/create-checkout-session', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkoutRequestId:'co_00000000000000000000000000000003', items: [{
        productType: 'tiny-frame',
        cartItemId:'ci_00000000000000000000000000000003',
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

test('quantity creates one unique five-digit code per physical frame and retries reuse them', async () => {
  const originalFetch = globalThis.fetch;
  let stripeBody;
  let stripeCalls = 0;
  globalThis.fetch = async (_url, options) => {
    stripeCalls += 1;
    stripeBody = new URLSearchParams(options.body);
    return Response.json({ id:'cs_test_quantity3', url:'https://checkout.stripe.test/quantity-3' });
  };
  try {
    const testEnv = env();
    const requestBody = JSON.stringify({
      checkoutRequestId:'co_00000000000000000000000000000006',
      items:[{
        productType:'tiny_frame_only',
        cartItemId:'ci_00000000000000000000000000000006',
        size:'80x80mm',
        frameColour:'Oak',
        quantity:3
      }]
    });
    const makeRequest = () => new Request('https://worker.example/create-checkout-session', {
      method:'POST',
      headers:{ Origin:ORIGIN, 'Content-Type':'application/json' },
      body:requestBody
    });
    const first = await worker.fetch(makeRequest(), testEnv);
    assert.equal(first.status, 200);
    const firstResult = await first.json();
    assert.equal(firstResult.productCodes.length, 3);
    assert.equal(new Set(firstResult.productCodes).size, 3);
    assert.equal(firstResult.productCodes.every(code => /^[1-9][0-9]{4}$/.test(code)), true);
    assert.deepEqual([0, 1, 2].map(index => (
      stripeBody.get(`line_items[${index}][price_data][product_data][metadata][product_code]`)
    )), firstResult.productCodes);
    assert.deepEqual([0, 1, 2].map(index => (
      stripeBody.get(`line_items[${index}][price_data][unit_amount]`)
    )), ['7000', '7000', '7000']);
    assert.equal(stripeBody.get('line_items[3][price_data][unit_amount]'), '1000');
    assert.equal(stripeBody.has('line_items[4][price_data][unit_amount]'), false);

    const retry = await worker.fetch(makeRequest(), testEnv);
    assert.equal(retry.status, 200);
    assert.deepEqual((await retry.json()).productCodes, firstResult.productCodes);
    assert.equal(stripeCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('authorized order management can find the Stripe relationship by product code', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    id:'cs_test_searchable1',
    url:'https://checkout.stripe.test/searchable'
  });
  try {
    const testEnv = { ...env(), ADMIN_API_KEY:'local-admin-key-at-least-24-characters' };
    const checkout = await worker.fetch(new Request('https://worker.example/create-checkout-session', {
      method:'POST',
      headers:{ Origin:ORIGIN, 'Content-Type':'application/json' },
      body:JSON.stringify({
        checkoutRequestId:'co_00000000000000000000000000000007',
        items:[{
          productType:'tiny_frame_only',
          cartItemId:'ci_00000000000000000000000000000007',
          size:'80x80mm',
          frameColour:'Walnut',
          quantity:1
        }]
      })
    }), testEnv);
    const productCode = (await checkout.json()).productCodes[0];
    const unauthorized = await worker.fetch(
      new Request(`https://worker.example/admin/product-code/${productCode}`),
      testEnv
    );
    assert.equal(unauthorized.status, 401);
    const authorized = await worker.fetch(new Request(
      `https://worker.example/admin/product-code/${productCode}`,
      { headers:{ Authorization:`Bearer ${testEnv.ADMIN_API_KEY}` } }
    ), testEnv);
    assert.equal(authorized.status, 200);
    const record = await authorized.json();
    assert.equal(record.productCode, productCode);
    assert.equal(record.stripeCheckoutSessionId, 'cs_test_searchable1');
    assert.equal(record.productType, 'tiny_frame_only');
    const capacity = await worker.fetch(new Request(
      'https://worker.example/admin/product-code-capacity',
      { headers:{ Authorization:`Bearer ${testEnv.ADMIN_API_KEY}` } }
    ), testEnv);
    assert.equal(capacity.status, 200);
    assert.equal((await capacity.json()).remaining, 89999);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('live webhook retries preserve one product and attach the PaymentIntent', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    id:'cs_live_webhookproduct1',
    url:'https://checkout.stripe.com/c/pay/webhook-product'
  });
  const webhookSecret = 'whsec_live_product_test';
  const liveEnv = {
    ...env(),
    STRIPE_MODE:'live',
    STRIPE_TEST_SECRET_KEY:undefined,
    STRIPE_SECRET_KEY:'sk_live_existing_configuration',
    STRIPE_WEBHOOK_SECRET:webhookSecret,
    SITE_BASE_URL:'https://goodframe.com.au',
    ADMIN_API_KEY:'local-admin-key-at-least-24-characters'
  };
  try {
    const checkout = await worker.fetch(new Request('https://worker.example/create-checkout-session', {
      method:'POST',
      headers:{ Origin:ORIGIN, 'Content-Type':'application/json' },
      body:JSON.stringify({
        checkoutRequestId:'co_00000000000000000000000000000008',
        items:[{
          productType:'tiny_frame_only',
          cartItemId:'ci_00000000000000000000000000000008',
          size:'80x80mm',
          frameColour:'Oak',
          quantity:1
        }]
      })
    }), liveEnv);
    const productCode = (await checkout.json()).productCodes[0];
    const eventBody = JSON.stringify({
      id:'evt_liveproductpaid1',
      type:'checkout.session.completed',
      livemode:true,
      data:{ object:{
        id:'cs_live_webhookproduct1',
        payment_intent:'pi_live_webhookproduct1',
        metadata:{}
      } }
    });
    const sendWebhook = () => worker.fetch(new Request('https://worker.example/stripe-webhook', {
      method:'POST',
      headers:{ 'Stripe-Signature':createStripeSignature(eventBody, webhookSecret) },
      body:eventBody
    }), liveEnv);
    assert.equal((await sendWebhook()).status, 200);
    const duplicate = await sendWebhook();
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).duplicate, true);

    const lookup = await worker.fetch(new Request(
      `https://worker.example/admin/product-code/${productCode}`,
      { headers:{ Authorization:`Bearer ${liveEnv.ADMIN_API_KEY}` } }
    ), liveEnv);
    const record = await lookup.json();
    assert.equal(record.status, 'paid');
    assert.equal(record.stripeCheckoutSessionId, 'cs_live_webhookproduct1');
    assert.equal(record.stripePaymentIntentId, 'pi_live_webhookproduct1');
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
    await seedPictureUpload(bucket, uploadReference);
    const response = await worker.fetch(new Request('https://worker.example/create-checkout-session', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkoutRequestId:'co_00000000000000000000000000000004', items: [
        { productType:'tiny_frame_only', cartItemId:'ci_00000000000000000000000000000004', size:'80x80mm', frameColour:'Oak', quantity:1 },
        { productType:'tiny_frame_8_pictures', cartItemId:'ci_00000000000000000000000000000005', size:'80x80mm', frameColour:'Walnut', quantity:1, uploadReference }
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
