import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker, {
  buildLineItems,
  claimWebhookEvent,
  cleanupPendingUploads,
  createStripePayload,
  markProductPdfFilesPaid,
  markUploadSessionsPaid
} from '../src/index.js';
import { createA4PrintSheetPdf } from '../src/print-sheet-pdf.js';
import { createProductCodeDatabase } from './helpers/d1.js';
await import('../../../print-sheet.js');

const uploadReference = 'tf_0123456789abcdef0123456789abcdef';

test('storefront cropper, eight previews, and FAQ use the 54 x 86 mm format', async () => {
  const html = await readFile(new URL('../../../index.html', import.meta.url), 'utf8');
  assert.match(html, /const frameAspectRatio = 54 \/ 86;/);
  assert.equal((html.match(/class="image-slot"/g) || []).length, 8);
  assert.equal((html.match(/aspect-ratio:54 \/ 86/g) || []).length, 3);
  assert.match(html, /\.slot-preview[^}]+object-fit:cover;/);
  assert.match(html, /photos measuring 54 × 86 mm/);
  assert.match(html, /let printUploadAttempt = null;/);
  assert.match(html, /if \(printUploadAttempt\.promise\) return printUploadAttempt\.promise;/);
  assert.match(html, /cartItems\.some\(\(item\) => item\.uploadSessionId === uploadSession\.uploadSessionId\)/);
  assert.match(html, /controller\.abort\(\), 600000/);
  assert.doesNotMatch(html, /requestUploadStage\("\/tiny-frame-pdf\/reserve/);
  assert.match(html, /\/tiny-frame-pdf\/upload/);
  assert.match(html, /\/product-code\/assign/);
  assert.doesNotMatch(html, /\/tiny-frame-upload\/original/);
  assert.doesNotMatch(html, /\/tiny-frame-upload\/finalize/);
  assert.match(html, /createFullResolutionPrintCrop/);
  assert.match(html, /printBlob,/);
  assert.match(html, /return entry\.printBlob/);
  assert.match(html, /revision:crypto\.randomUUID\(\)/);
  assert.doesNotMatch(html, /no longer matches its saved crop/);
  assert.match(html, /cropFrameIsPortrait \? croppedCanvas : rotateCanvasClockwise\(croppedCanvas\)/);
  assert.match(html, /productCode:attempt\.productCode/);
  assert.match(html, /\.image-remove-button \{[^}]*top:4px; right:4px;[^}]*transform:none;/);
  assert.doesNotMatch(html, /\.image-remove-button \{[^}]*translate\(50%,-50%\)/);
  assert.match(html, /id="checkout-confirmed-dialog"/);
  assert.match(html, /id="checkout-unsuccessful-dialog"/);
  assert.match(html, /Thank you for your order\. Your tiny frames are on their way to becoming something special\./);
  assert.match(html, /Your payment wasn't completed\. Your items are still waiting in your cart\./);
  assert.match(html, /result\.outcome === "confirmed"/);
  assert.match(html, /result\.outcome === "failed"/);
  assert.match(html, /checkoutState === "cancelled"\) \{\s*openCart\(\);/);
  assert.doesNotMatch(html, /checkoutState === "cancelled"\) \{\s*await showUnsuccessfulCheckout\(\);/);
  assert.match(html, /clearPurchasedCartItems\(checkoutContext\)/);
  assert.match(html, /checkout_request_id:checkoutContext\.id/);
  assert.match(html, /title\.textContent = `\$\{item\.colour\} · \$\{normalizeOrderType\(item\.order\) === "frame-plus-pictures" \? "Frame \+ 8 Pictures" : "Frame Only"\}`;/);
  assert.doesNotMatch(html, /title\.textContent[^;]+item\.productCode/);
  assert.doesNotMatch(html, /product identification code could not be verified/i);
});

test('A4 print layout uses exact 54 x 86 mm crops in a centred 3/3/2 grid', () => {
  const api = globalThis.GoodFramePrintSheet;
  assert.deepEqual(api.specification, {
    pageWidthMm:210,
    pageHeightMm:297,
    photoWidthMm:54,
    photoHeightMm:86,
    gapMm:5,
    guideWidthPt:0.25,
    cropMarkGapMm:2.5,
    cropMarkLengthMm:2,
    productCodeLabelBaselineMm:5,
    productCodeLabelFontSizePt:9
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

test('product code label sits in the A4 margin without changing image or cut geometry', () => {
  const pdf = createA4PrintSheetPdf(
    Array.from({ length:8 }, () => ({ bytes:fakeJpeg() })),
    { productCode:'58321' }
  );
  const text = new TextDecoder('latin1').decode(pdf);
  assert.match(text, /\(PRODUCT 58321\) Tj/);
  assert.equal((text.match(/\/Subtype\s*\/Image\b/g) || []).length, 8);
  assert.equal((text.match(/q\s+153\.070866\s+0\s+0\s+243\.779528/g) || []).length, 8);
  assert.match(text, /1 0 0 1 232\.440945 14\.173228 Tm \(PRODUCT 58321\)/);
});

class MemoryR2Bucket {
  constructor() {
    this.objects = new Map();
  }
  async head(key) {
    const stored = this.objects.get(key);
    return stored ? { key, size:stored.bytes.byteLength, customMetadata:stored.customMetadata } : null;
  }
  async put(key, body, options = {}) {
    if (options.onlyIf?.etagDoesNotMatch === '*' && this.objects.has(key)) return null;
    const bytes = await new Response(body).arrayBuffer();
    this.objects.set(key, {
      bytes,
      contentType:options.httpMetadata?.contentType || 'application/octet-stream',
      customMetadata:{ ...(options.customMetadata || {}) }
    });
    return { key };
  }
  async get(key) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      body:stored.bytes,
      customMetadata:{ ...stored.customMetadata },
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

const pictureCartItemId = 'ci_22222222222222222222222222222222';

function reserveProductPdfRequest(cartItemId = pictureCartItemId) {
  return new Request('https://worker.example/tiny-frame-pdf/reserve', {
    method:'POST',
    headers:{ Origin:'https://goodframe.com.au', 'Content-Type':'application/json' },
    body:JSON.stringify({ cartItemId, frameColour:'Oak' })
  });
}

function assignProductCodeRequest(cartItemId, productType = 'tiny_frame_only', productCode = '58321') {
  return new Request('https://worker.example/product-code/assign', {
    method:'POST',
    headers:{ Origin:'https://goodframe.com.au', 'Content-Type':'application/json' },
    body:JSON.stringify({ cartItemId, frameColour:'Oak', productType, productCode })
  });
}

function uploadProductPdfRequest(productCode, cartItemId = pictureCartItemId, pdfBytes = null) {
  const filename = `${productCode}-print-sheet.pdf`;
  const bytes = pdfBytes || createA4PrintSheetPdf(
    Array.from({ length:8 }, () => ({ bytes:fakeJpeg() })),
    { productCode }
  );
  const form = new FormData();
  form.append('cart_item_id', cartItemId);
  form.append('product_code', productCode);
  form.append('pdf', new File([bytes], filename, { type:'application/pdf' }));
  return new Request('https://worker.example/tiny-frame-pdf/upload', {
    method:'POST',
    headers:{ Origin:'https://goodframe.com.au' },
    body:form
  });
}

function oneStepProductPdfRequest(cartItemId = pictureCartItemId, productCode = '58321', pdfBytes = null) {
  const bytes = pdfBytes || createA4PrintSheetPdf(
    Array.from({ length:8 }, () => ({ bytes:fakeJpeg() })),
    { productCode }
  );
  const form = new FormData();
  form.append('cart_item_id', cartItemId);
  form.append('product_code', productCode);
  form.append('frame_colour', 'Oak');
  form.append('pdf', new File([bytes], `${productCode}-print-sheet.pdf`, { type:'application/pdf' }));
  return new Request('https://worker.example/tiny-frame-pdf/upload', {
    method:'POST',
    headers:{ Origin:'https://goodframe.com.au' },
    body:form
  });
}

async function uploadAndAssignProductPdf(env, cartItemId = pictureCartItemId, productCode = '58321') {
  const uploadResponse = await worker.fetch(oneStepProductPdfRequest(cartItemId, productCode), env);
  const result = await uploadResponse.clone().json();
  return { result, uploadResponse };
}

function frameOnly(overrides = {}) {
  return {
    productType: 'tiny_frame_only',
    cartItemId:'ci_11111111111111111111111111111111',
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
    cartItemId:'ci_22222222222222222222222222222222',
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
  let productIndex = 0;
  const lineItems = buildLineItems([frameOnly(), frameWithPictures()]).map(item => (
    item.cartItemId ? { ...item, productCode:['58321', '19472'][productIndex++] } : item
  ));
  const payload = createStripePayload(lineItems, 'https://goodframe.com.au', 'live', 'co_0123456789abcdef0123456789abcdef');

  assert.equal(payload.get('line_items[0][price_data][unit_amount]'), '7000');
  assert.equal(payload.get('line_items[1][price_data][unit_amount]'), '9000');
  assert.equal(payload.get('line_items[2][price_data][unit_amount]'), '1000');
  assert.equal(payload.get('line_items[0][price_data][product_data][name]'), 'OAK · FRAME ONLY');
  assert.equal(payload.get('line_items[1][price_data][product_data][name]'), 'WALNUT · FRAME + 8 PICTURES');
  assert.equal(payload.has('line_items[0][price_data][product_data][description]'), false);
  assert.equal(payload.has('line_items[1][price_data][product_data][description]'), false);
  assert.equal(payload.get('line_items[0][price_data][product_data][metadata][product_type]'), 'tiny_frame_only');
  assert.equal(payload.get('line_items[1][price_data][product_data][metadata][product_type]'), 'tiny_frame_8_pictures');
  assert.equal(payload.get('line_items[1][price_data][product_data][metadata][frame_colour]'), 'Walnut');
  assert.equal(payload.get('line_items[1][price_data][product_data][metadata][upload_reference]'), uploadReference);
  assert.equal(payload.get('line_items[1][price_data][product_data][metadata][upload_session_id]'), uploadReference);
  assert.equal(payload.get('line_items[0][price_data][product_data][metadata][product_code]'), '58321');
  assert.equal(payload.get('line_items[1][price_data][product_data][metadata][product_code]'), '19472');
  assert.equal(payload.get('metadata[product_codes]'), '58321,19472');
  assert.equal(payload.get('payment_intent_data[metadata][product_codes]'), '58321,19472');
  const productMap = '1:58321 | Oak | OAK · FRAME ONLY | AUD 70.00; 2:19472 | Walnut | WALNUT · FRAME + 8 PICTURES | AUD 90.00 | PDF 19472/19472-print-sheet.pdf';
  assert.equal(payload.get('metadata[product_map]'), productMap);
  assert.equal(payload.get('payment_intent_data[metadata][product_map]'), productMap);
  assert.equal(payload.get('payment_intent_data[metadata][frame_colours]'), 'Oak,Walnut');
  assert.equal(payload.get('payment_intent_data[description]'), 'Good Frame Order');
  assert.equal(payload.get('metadata[upload_references]'), uploadReference);
  assert.equal(payload.get('metadata[upload_session_ids]'), uploadReference);
  assert.equal(payload.get('success_url'), 'https://goodframe.com.au/?checkout=success&session_id={CHECKOUT_SESSION_ID}');
  assert.equal(payload.get('cancel_url'), 'https://goodframe.com.au/?checkout=cancelled#cart');
  assert.equal([...payload.keys()].some(key => key.includes('artwork_object_keys')), false);
});

test('Stripe metadata uses the same code as the five-digit R2 folder', () => {
  const productCode = '58321';
  const objectKey = `${productCode}/${productCode}-print-sheet.pdf`;
  const lineItems = buildLineItems([frameWithPictures({ uploadReference:objectKey })])
    .map(item => item.cartItemId ? { ...item, productCode } : item);
  const payload = createStripePayload(
    lineItems,
    'https://goodframe.com.au',
    'live',
    'co_0123456789abcdef0123456789abcdef'
  );
  assert.equal(payload.get('metadata[product_codes]'), productCode);
  assert.equal(payload.get('metadata[upload_references]'), objectKey);
  assert.equal(payload.get('line_items[0][price_data][product_data][metadata][product_code]'), productCode);
  assert.equal(payload.get('line_items[0][price_data][product_data][metadata][upload_reference]'), objectKey);
  assert.match(payload.get('payment_intent_data[metadata][product_map]'), /58321\/58321-print-sheet\.pdf/);
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

test('PDF-only upload stores exactly one code-named A4 print sheet', async () => {
  const bucket = new MemoryR2Bucket();
  const database = createProductCodeDatabase();
  const env = {
    ARTWORK_BUCKET:bucket,
    PRODUCT_CODES_DB:database,
    ALLOWED_ORIGINS:'https://goodframe.com.au'
  };
  const { result, uploadResponse } = await uploadAndAssignProductPdf(env);
  assert.equal(uploadResponse.status, 200);
  assert.equal(result.success, true);
  assert.match(result.productCode, /^[1-9][0-9]{4}$/);
  assert.equal(result.pdf.filename, `${result.productCode}-print-sheet.pdf`);
  assert.equal(result.pdf.objectKey, `${result.productCode}/${result.productCode}-print-sheet.pdf`);
  assert.equal(bucket.objects.size, 1);
  assert.deepEqual([...bucket.objects.keys()], [result.pdf.objectKey]);
  const stored = bucket.objects.get(result.pdf.objectKey);
  assert.equal(stored.contentType, 'application/pdf');
  assert.equal(stored.customMetadata.product_code, result.productCode);
  assert.equal(stored.customMetadata.cart_item_id, pictureCartItemId);
  assert.equal(stored.customMetadata.image_count, '8');
  assert.equal(stored.customMetadata.status, 'pending');
  const text = new TextDecoder('latin1').decode(stored.bytes);
  assert.match(text, new RegExp(`\\(PRODUCT ${result.productCode}\\) Tj`));
  assert.equal((text.match(/\/Subtype \/Image/g) || []).length, 8);
  assert.equal((text.match(/153\.070866 243\.779528 re S/g) || []).length, 8);
  database.close();
});

test('single-request upload retries preserve one code and one R2 object', async () => {
  const bucket = new MemoryR2Bucket();
  const database = createProductCodeDatabase();
  const env = {
    ARTWORK_BUCKET:bucket,
    PRODUCT_CODES_DB:database,
    ALLOWED_ORIGINS:'https://goodframe.com.au'
  };
  const firstUpload = await worker.fetch(oneStepProductPdfRequest(), env);
  assert.equal(firstUpload.status, 200);
  const firstResult = await firstUpload.json();
  const retryUpload = await worker.fetch(oneStepProductPdfRequest(), env);
  assert.equal(retryUpload.status, 200);
  const retryResult = await retryUpload.json();
  assert.equal(retryResult.retry_recovered, true);
  assert.equal(retryResult.productCode, firstResult.productCode);
  assert.equal(bucket.objects.size, 1);
  database.close();
});

test('two products receive different five-digit R2 folders and code-named PDFs', async () => {
  const bucket = new MemoryR2Bucket();
  const database = createProductCodeDatabase();
  const env = {
    ARTWORK_BUCKET:bucket,
    PRODUCT_CODES_DB:database,
    ALLOWED_ORIGINS:'https://goodframe.com.au'
  };
  const firstCartItemId = 'ci_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const secondCartItemId = 'ci_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const first = await uploadAndAssignProductPdf(env, firstCartItemId, '58321');
  const second = await uploadAndAssignProductPdf(env, secondCartItemId, '19472');
  assert.equal(first.uploadResponse.status, 200);
  assert.equal(second.uploadResponse.status, 200);
  assert.notEqual(first.result.productCode, second.result.productCode);
  assert.deepEqual(new Set(bucket.objects.keys()), new Set([
    `${first.result.productCode}/${first.result.productCode}-print-sheet.pdf`,
    `${second.result.productCode}/${second.result.productCode}-print-sheet.pdf`
  ]));
  database.close();
});

test('frame-only products receive unique persistent codes in one assignment request', async () => {
  const database = createProductCodeDatabase();
  const env = {
    PRODUCT_CODES_DB:database,
    ALLOWED_ORIGINS:'https://goodframe.com.au'
  };
  const firstId = 'ci_cccccccccccccccccccccccccccccccc';
  const secondId = 'ci_dddddddddddddddddddddddddddddddd';
  const first = await (await worker.fetch(assignProductCodeRequest(firstId, 'tiny_frame_only', '58321'), env)).json();
  const firstRetry = await (await worker.fetch(assignProductCodeRequest(firstId, 'tiny_frame_only', '58321'), env)).json();
  const second = await (await worker.fetch(assignProductCodeRequest(secondId, 'tiny_frame_only', '19472'), env)).json();
  assert.match(first.productCode, /^[1-9][0-9]{4}$/);
  assert.equal(firstRetry.productCode, first.productCode);
  assert.notEqual(second.productCode, first.productCode);
  database.close();
});

test('PDF upload rejects a sheet with a missing or mismatched product label', async () => {
  const bucket = new MemoryR2Bucket();
  const database = createProductCodeDatabase();
  const env = {
    ARTWORK_BUCKET:bucket,
    PRODUCT_CODES_DB:database,
    ALLOWED_ORIGINS:'https://goodframe.com.au'
  };
  const reservation = await (await worker.fetch(reserveProductPdfRequest(), env)).json();
  const wrongPdf = createA4PrintSheetPdf(
    Array.from({ length:8 }, () => ({ bytes:fakeJpeg() })),
    { productCode:reservation.productCode === '58321' ? '19472' : '58321' }
  );
  const response = await worker.fetch(uploadProductPdfRequest(reservation.productCode, pictureCartItemId, wrongPdf), env);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /matching product code/);
  assert.equal(bucket.objects.size, 0);
  database.close();
});

test('browser PDF builder preserves all eight full-resolution JPEG dimensions', async () => {
  const blobs = Array.from({ length:8 }, (_, index) => new Blob(
    [fakeJpeg(2160 + index, 3440 + Math.round(index * (3440 / 2160)))],
    { type:'image/jpeg' }
  ));
  const pdf = await globalThis.GoodFramePrintSheet.createA4PrintSheetPdf(blobs, { productCode:'58321' });
  const text = new TextDecoder('latin1').decode(await pdf.arrayBuffer());
  assert.equal((text.match(/\/Subtype \/Image/g) || []).length, 8);
  assert.match(text, /\(PRODUCT 58321\) Tj/);
  blobs.forEach((_, index) => {
    assert.match(text, new RegExp(`/Width ${2160 + index} /Height ${3440 + Math.round(index * (3440 / 2160))}`));
  });
});

test('paid Stripe sessions promote only the code-named product PDF', async () => {
  const bucket = new MemoryR2Bucket();
  const database = createProductCodeDatabase();
  const env = {
    ARTWORK_BUCKET:bucket,
    PRODUCT_CODES_DB:database,
    ALLOWED_ORIGINS:'https://goodframe.com.au'
  };
  const { result, uploadResponse } = await uploadAndAssignProductPdf(env);
  assert.equal(uploadResponse.status, 200);
  assert.equal(await markProductPdfFilesPaid({
    id:'cs_live_tiny_frame_paid',
    metadata:{ product_codes:result.productCode }
  }, env), 1);
  const key = `${result.productCode}/${result.productCode}-print-sheet.pdf`;
  const stored = bucket.objects.get(key);
  assert.equal(stored.customMetadata.status, 'paid');
  assert.equal(stored.customMetadata.stripe_checkout_session_id, 'cs_live_tiny_frame_paid');
  assert.match(stored.customMetadata.paid_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(bucket.objects.size, 1);
  database.close();
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
