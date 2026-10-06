import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {
  buildLineItems,
  claimWebhookEvent,
  cleanupPendingUploads,
  createStripePayload,
  markUploadSessionsPaid
} from '../src/index.js';
await import('../../../print-sheet.js');

const uploadReference = 'tf_0123456789abcdef0123456789abcdef';

test('A4 print layout uses exact 54 x 86 mm crops in a centred 3/3/2 grid', () => {
  const api = globalThis.GoodFramePrintSheet;
  assert.deepEqual(api.specification, {
    pageWidthMm:210,
    pageHeightMm:297,
    photoWidthMm:54,
    photoHeightMm:86,
    gapMm:5
  });
  const placements = api.getA4PrintLayout();
  assert.equal(placements.length, 8);
  assert.equal(placements.every(item => item.widthMm === 54 && item.heightMm === 86), true);
  assert.deepEqual(placements.map(item => [item.xMm, item.yMm]), [
    [19, 196.5], [78, 196.5], [137, 196.5],
    [19, 105.5], [78, 105.5], [137, 105.5],
    [48.5, 14.5], [107.5, 14.5]
  ]);
});

class MemoryR2Bucket {
  constructor() {
    this.objects = new Map();
  }
  async head(key) {
    return this.objects.has(key) ? { key } : null;
  }
  async put(key, body, options = {}) {
    if (options.onlyIf?.etagDoesNotMatch === '*' && this.objects.has(key)) return null;
    const bytes = await new Response(body).arrayBuffer();
    this.objects.set(key, { bytes, contentType:options.httpMetadata?.contentType || 'application/octet-stream' });
    return { key };
  }
  async get(key) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      body:stored.bytes,
      text:async () => new TextDecoder().decode(stored.bytes),
      json:async () => JSON.parse(new TextDecoder().decode(stored.bytes))
    };
  }
  async delete(key) {
    this.objects.delete(key);
  }
  async list({ prefix = '' } = {}) {
    return {
      objects:[...this.objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })),
      truncated:false
    };
  }
}

function testPrintSheetPdf({ imageCount = 8, width = '595.275591', height = '841.889764' } = {}) {
  const images = Array.from({ length:imageCount }, () => '<< /Type /XObject /Subtype /Image >>').join('\n');
  return new Blob([
    `%PDF-1.4\n1 0 obj\n<< /Type /Page /MediaBox [0 0 ${width} ${height}] >>\nendobj\n${images}\n%%EOF`
  ], { type:'application/pdf' });
}

function uploadPrintSheetRequest({ imageCount = 8, sessionId = uploadReference, frameColour = 'Oak', pdfOptions = {} } = {}) {
  const form = new FormData();
  form.append('upload_session_id', sessionId);
  form.append('frame_colour', frameColour);
  form.append('image_count', String(imageCount));
  form.append('print_sheet', testPrintSheetPdf(pdfOptions), 'print-sheet-a4.pdf');
  return new Request('https://worker.example/upload-print-sheet', {
    method:'POST',
    headers: { Origin:'https://goodframe.com.au' },
    body:form
  });
}

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
  assert.equal(payload.get('line_items[1][price_data][product_data][metadata][upload_session_id]'), uploadReference);
  assert.equal(payload.get('metadata[upload_references]'), uploadReference);
  assert.equal(payload.get('metadata[upload_session_ids]'), uploadReference);
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

test('upload-print-sheet stores one A4 PDF and a pending manifest', async () => {
  const bucket = new MemoryR2Bucket();
  const env = { ARTWORK_BUCKET:bucket, ALLOWED_ORIGINS:'https://goodframe.com.au' };
  const response = await worker.fetch(uploadPrintSheetRequest(), env);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.success, true);
  assert.equal(result.upload_session_id, uploadReference);
  assert.equal(result.print_sheet.filename, 'print-sheet-a4.pdf');
  assert.equal(result.print_sheet.objectKey, `tinyframes/${uploadReference}/print-sheet-a4.pdf`);
  const manifestKey = `tinyframes/${uploadReference}/manifest.json`;
  assert.equal(bucket.objects.size, 2);
  const manifest = await (await bucket.get(manifestKey)).json();
  assert.equal(manifest.status, 'pending');
  assert.equal(manifest.frame_colour, 'Oak');
  assert.equal(manifest.product_type, 'frame_8_pictures');
  assert.equal(manifest.image_count, 8);
  assert.equal(manifest.print_sheet_filename, 'print-sheet-a4.pdf');
  assert.equal(manifest.print_sheet_object_key, `tinyframes/${uploadReference}/print-sheet-a4.pdf`);
  assert.deepEqual(manifest.page_size_mm, { width:210, height:297 });
  assert.deepEqual(manifest.photo_size_mm, { width:54, height:86 });
});

test('upload-print-sheet rejects a sheet that does not represent eight crops', async () => {
  const bucket = new MemoryR2Bucket();
  const response = await worker.fetch(uploadPrintSheetRequest({ imageCount:7, pdfOptions:{ imageCount:7 } }), {
    ARTWORK_BUCKET:bucket,
    ALLOWED_ORIGINS:'https://goodframe.com.au'
  });
  assert.equal(response.status, 400);
  assert.equal(bucket.objects.size, 0);
});

test('upload-print-sheet rejects a PDF with non-A4 page dimensions', async () => {
  const bucket = new MemoryR2Bucket();
  const response = await worker.fetch(uploadPrintSheetRequest({ pdfOptions:{ width:'612', height:'792' } }), {
    ARTWORK_BUCKET:bucket,
    ALLOWED_ORIGINS:'https://goodframe.com.au'
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /exact portrait A4/);
  assert.equal(bucket.objects.size, 0);
});

test('paid Stripe sessions promote pending upload manifests', async () => {
  const bucket = new MemoryR2Bucket();
  const env = { ARTWORK_BUCKET:bucket, ALLOWED_ORIGINS:'https://goodframe.com.au' };
  assert.equal((await worker.fetch(uploadPrintSheetRequest(), env)).status, 200);
  assert.equal(await markUploadSessionsPaid({
    id:'cs_test_tiny_frame_paid',
    metadata:{ upload_session_ids:uploadReference }
  }, env), 1);
  const manifest = await (await bucket.get(`tinyframes/${uploadReference}/manifest.json`)).json();
  assert.equal(manifest.status, 'paid');
  assert.equal(manifest.stripe_checkout_session_id, 'cs_test_tiny_frame_paid');
  assert.match(manifest.paid_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('cleanup removes stale pending sessions but preserves paid uploads', async () => {
  const bucket = new MemoryR2Bucket();
  const oldPendingId = 'tf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const paidId = 'tf_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const oldDate = '2026-09-01T00:00:00.000Z';
  for (const [sessionId, status] of [[oldPendingId, 'pending'], [paidId, 'paid']]) {
    const imageKey = `tinyframes/${sessionId}/01.jpg`;
    await bucket.put(imageKey, 'image', { httpMetadata:{ contentType:'image/jpeg' } });
    await bucket.put(`tinyframes/${sessionId}/manifest.json`, JSON.stringify({
      upload_session_id:sessionId,
      status,
      uploaded_at:oldDate,
      files:[{ objectKey:imageKey }]
    }), { httpMetadata:{ contentType:'application/json' } });
  }
  const deleted = await cleanupPendingUploads({ ARTWORK_BUCKET:bucket, PENDING_UPLOAD_TTL_DAYS:'10' }, Date.parse('2026-10-06T00:00:00.000Z'));
  assert.equal(deleted, 1);
  assert.equal(bucket.objects.has(`tinyframes/${oldPendingId}/manifest.json`), false);
  assert.equal(bucket.objects.has(`tinyframes/${oldPendingId}/01.jpg`), false);
  assert.equal(bucket.objects.has(`tinyframes/${paidId}/manifest.json`), true);
  assert.equal(bucket.objects.has(`tinyframes/${paidId}/01.jpg`), true);
});
