import assert from 'node:assert/strict';
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
    STRIPE_SECRET_KEY: 'sk_test_example',
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
  globalThis.fetch = async (_url, options) => {
    stripeBody = new URLSearchParams(options.body);
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
    assert.equal(stripeBody.get('line_items[0][price_data][product_data][metadata][original_object_key]'), originalObjectKey);
    assert.equal(stripeBody.get('line_items[0][price_data][product_data][metadata][thumbnail_object_key]'), thumbnailObjectKey);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
