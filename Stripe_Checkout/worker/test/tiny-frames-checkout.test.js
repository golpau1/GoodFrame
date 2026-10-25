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

test('storefront uploads cropped photos individually in the background', async () => {
  const html = await readFile(new URL('../../../index.html', import.meta.url), 'utf8');
  assert.match(html, /const frameAspectRatio = 54 \/ 86;/);
  assert.match(html, /const uploadedImages = Array\(3\)\.fill\(null\);/);
  assert.match(html, /for \(let offset = 0; offset < 3; offset \+= 1\)/);
  assert.match(html, /input\.multiple = true;/);
  assert.match(html, /MAX_CONCURRENT_PHOTO_UPLOADS = 2/);
  assert.match(html, /\/tiny-frame-upload\/session/);
  assert.match(html, /\/tiny-frame-upload\/photo/);
  assert.match(html, /\/tiny-frame-upload\/finalize/);
  assert.match(html, /uploadState:\"queued\"/);
  assert.match(html, /Upload failed · Retry/);
  assert.match(html, /entry\?\.uploadState === \"complete\"/);
  assert.match(html, /finalizeIndividualUploads\(uploadedImages, selections\.colour\)/);
  assert.match(html, /photoFiles:uploadSession\.photos/);
  assert.doesNotMatch(html, /<script src=\"print-sheet\.js\"><\/script>/);
  assert.doesNotMatch(html, /GoodFramePrintSheet/);
  assert.doesNotMatch(html, /\/tiny-frame-pdf\/upload/);
  assert.match(html, /entry\?\.previewBlob instanceof Blob \? entry\.previewBlob : entry\?\.printBlob/);
  assert.match(html, /cropFrameIsPortrait \? croppedCanvas : rotateCanvasClockwise\(croppedCanvas\)/);
  assert.match(html, /id=\"cropper-progress-label\">Photo 1 of 1/);
  assert.match(html, /function startCropBatch\(files, slotIndices, returnFocus\)/);
  assert.match(html, /selectedFiles\.slice\(0, targetSlots\.length\)/);
  assert.match(html, /function appendPhotoSet\(setIndex\)/);
  assert.match(html, /function preserveScrollDuringLayoutChange/);
  assert.match(html, /id=\"product-name\">Frame &amp; Photos</);
  assert.match(html, /<h2 class=\"palette-title\">FRAME COLOUR<\/h2>/);
  assert.match(html, /const BASE_FRAME_PRICE = 50;/);
  assert.match(html, /const PHOTO_SET_PRICE = 6;/);
  assert.match(html, /id=\"config-price\">56\.00</);
  assert.match(html, /id=\"add-photo-set\"[^>]*>\+ Add Another 3 Photos — \$6</);
  assert.match(html, /\.photo-sets \{ display:grid; height:auto; gap:22px; overflow:visible; \}/);
  assert.match(html, /\.configurator\.is-open \{ height:auto; max-height:none;[^}]*overflow:visible/);
  assert.match(html, /hero-mobile-DSCF1619\.jpg/);
});

test('individual cropped photos are authenticated, resumable, finalized, and promoted after payment', async () => {
  const bucket = new MemoryR2Bucket();
  const database = createProductCodeDatabase();
  const env = {
    ARTWORK_BUCKET:bucket,
    PRODUCT_CODES_DB:database,
    ADMIN_API_KEY:'admin-key-that-is-at-least-24-characters',
    ALLOWED_ORIGINS:'https://goodframe.com.au',
    IMAGES:{ info:async () => ({ width:1080, height:1720 }) }
  };
  const uploadSessionId = 'tf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const uploadToken = `ut_${'b'.repeat(64)}`;
  const cartItemId = 'ci_cccccccccccccccccccccccccccccccc';
  const headers = { Origin:'https://goodframe.com.au', 'X-Upload-Token':uploadToken };
  const sessionResponse = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/session', {
    method:'POST',
    headers:{ Origin:'https://goodframe.com.au', 'Content-Type':'application/json' },
    body:JSON.stringify({ uploadSessionId, uploadToken })
  }), env);
  assert.equal(sessionResponse.status, 200);

  const photos = [];
  for (let index = 0; index < 3; index += 1) {
    const photoId = `ph_${String(index + 1).repeat(32)}`;
    const revision = `${String(index + 4).repeat(8)}-${String(index + 4).repeat(4)}-${String(index + 4).repeat(4)}-${String(index + 4).repeat(4)}-${String(index + 4).repeat(12)}`;
    const form = new FormData();
    form.append('upload_session_id', uploadSessionId);
    form.append('photo_id', photoId);
    form.append('revision', revision);
    form.append('position', String(index + 1));
    form.append('file', new File([fakeJpeg()], `${photoId}.jpg`, { type:'image/jpeg' }));
    const response = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/photo', {
      method:'POST', headers, body:form
    }), env);
    assert.equal(response.status, 200);
    photos.push((await response.json()).photo);
    photos[index].revision = revision;
  }

  const statusResponse = await worker.fetch(new Request(`https://worker.example/tiny-frame-upload/status?upload_session_id=${uploadSessionId}`, { headers }), env);
  const status = await statusResponse.json();
  assert.equal(status.photos.length, 3);
  assert.deepEqual(status.photos.map(photo => photo.position), [1, 2, 3]);

  const finalizeResponse = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/finalize', {
    method:'POST',
    headers:{ ...headers, 'Content-Type':'application/json' },
    body:JSON.stringify({
      uploadSessionId,
      cartItemId,
      frameColour:'Oak',
      photoSetCount:1,
      photos:photos.map((photo, index) => ({
        photoId:photo.photoId,
        objectKey:photo.objectKey,
        revision:photo.revision,
        position:index + 1
      }))
    })
  }), env);
  assert.equal(finalizeResponse.status, 200);

  const manifestKey = `tinyframes/${uploadSessionId}/manifest.json`;
  const manifest = await (await bucket.get(manifestKey)).json();
  await bucket.put(manifestKey, JSON.stringify({ ...manifest, product_codes:['58321'] }), { httpMetadata:{ contentType:'application/json' } });
  await markUploadSessionsPaid({
    id:'cs_live_individual_photos',
    metadata:{ upload_session_ids:uploadSessionId }
  }, env);
  const finalManifest = await (await bucket.get('orders/cs_live_individual_photos/product-58321/manifest.json')).json();
  assert.equal(finalManifest.photo_count, 3);
  assert.equal(finalManifest.photos.length, 3);

  database.prepare(`INSERT INTO product_codes
    (code, cart_item_id, unit_index, product_type, upload_session_id, stripe_checkout_session_id, status, created_at, paid_at, frame_colour, unit_amount, currency)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind('58321', cartItemId, 0, 'tiny_frame_photo_sets', uploadSessionId, 'cs_live_individual_photos', 'paid', new Date().toISOString(), new Date().toISOString(), 'Oak', 5600, 'aud')
    .run();
  const adminHeaders = { Authorization:'Bearer admin-key-that-is-at-least-24-characters' };
  const assetResponse = await worker.fetch(new Request('https://worker.example/admin/product-assets/58321', { headers:adminHeaders }), env);
  const assets = await assetResponse.json();
  assert.equal(assets.photoCount, 3);
  assert.equal(assets.photos[0].downloadUrl, '/admin/product-assets/58321/photo/1');
  const downloadResponse = await worker.fetch(new Request('https://worker.example/admin/product-assets/58321/photo/1', { headers:adminHeaders }), env);
  assert.equal(downloadResponse.status, 200);
  assert.equal(downloadResponse.headers.get('Content-Type'), 'image/jpeg');
  assert.equal((await downloadResponse.arrayBuffer()).byteLength, fakeJpeg().byteLength);
  database.close();
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

test('variable print sheets add A4 pages after every nine photos', () => {
  const pdf = createA4PrintSheetPdf(
    Array.from({ length:12 }, () => ({ bytes:fakeJpeg() })),
    { productCode:'58321' }
  );
  const text = new TextDecoder('latin1').decode(pdf);
  assert.match(text, /\/Type \/Pages \/Kids \[[^\]]+\] \/Count 2/);
  assert.equal((text.match(/\/MediaBox \[0 0 595\.275591 841\.889764\]/g) || []).length, 2);
  assert.equal((text.match(/\/Subtype \/Image/g) || []).length, 12);
  assert.equal((text.match(/\(PRODUCT 58321\) Tj/g) || []).length, 2);
});

class MemoryR2Bucket {
  constructor() {
    this.objects = new Map();
    this.multipartUploads = new Map();
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
  async get(key, options = {}) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    const source = new Uint8Array(stored.bytes);
    const range = options.range;
    const bytes = range
      ? source.slice(range.offset, range.offset + range.length).buffer
      : stored.bytes;
    return {
      body:bytes,
      customMetadata:{ ...stored.customMetadata },
      text:async () => new TextDecoder().decode(bytes),
      json:async () => JSON.parse(new TextDecoder().decode(bytes))
    };
  }
  createMultipartUpload(key, options = {}) {
    const uploadId = `upload-${this.multipartUploads.size + 1}`;
    this.multipartUploads.set(uploadId, { key, options, parts:new Map() });
    return this.resumeMultipartUpload(key, uploadId);
  }
  resumeMultipartUpload(key, uploadId) {
    const bucket = this;
    return {
      key,
      uploadId,
      async uploadPart(partNumber, value) {
        const upload = bucket.multipartUploads.get(uploadId);
        if (!upload || upload.key !== key) throw new Error('No such multipart upload');
        const bytes = new Uint8Array(await new Response(value).arrayBuffer());
        const etag = `etag-${partNumber}-${bytes.byteLength}`;
        upload.parts.set(partNumber, { bytes, etag });
        return { partNumber, etag };
      },
      async complete(parts) {
        const upload = bucket.multipartUploads.get(uploadId);
        if (!upload || upload.key !== key) throw new Error('No such multipart upload');
        const chunks = parts.map(({ partNumber, etag }) => {
          const part = upload.parts.get(partNumber);
          if (!part || part.etag !== etag) throw new Error('Invalid multipart part');
          return part.bytes;
        });
        const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const bytes = new Uint8Array(length);
        let offset = 0;
        chunks.forEach((chunk) => {
          bytes.set(chunk, offset);
          offset += chunk.length;
        });
        bucket.objects.set(key, {
          bytes:bytes.buffer,
          contentType:upload.options.httpMetadata?.contentType || 'application/octet-stream',
          customMetadata:{ ...(upload.options.customMetadata || {}) }
        });
        bucket.multipartUploads.delete(uploadId);
        return { key, size:length };
      },
      async abort() {
        bucket.multipartUploads.delete(uploadId);
      }
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

function variableProductPdfRequest(photoSetCount, cartItemId = 'ci_33333333333333333333333333333333', productCode = '73194') {
  const photoCount = photoSetCount * 3;
  const bytes = createA4PrintSheetPdf(
    Array.from({ length:photoCount }, () => ({ bytes:fakeJpeg() })),
    { productCode }
  );
  const form = new FormData();
  form.append('cart_item_id', cartItemId);
  form.append('product_code', productCode);
  form.append('frame_colour', 'Walnut');
  form.append('photo_set_count', String(photoSetCount));
  form.append('photo_count', String(photoCount));
  form.append('pdf', new File([bytes], `${productCode}-print-sheet.pdf`, { type:'application/pdf' }));
  return new Request('https://worker.example/tiny-frame-pdf/upload', {
    method:'POST',
    headers:{ Origin:'https://goodframe.com.au' },
    body:form
  });
}

function multipartRequest(path, body, contentType = 'application/json') {
  return new Request(`https://worker.example${path}`, {
    method:'POST',
    headers:{ Origin:'https://goodframe.com.au', 'Content-Type':contentType },
    body:contentType === 'application/json' ? JSON.stringify(body) : body
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

function frameWithPhotoSets(photoSetCount, overrides = {}) {
  return {
    productType:'tiny_frame_photo_sets',
    cartItemId:'ci_33333333333333333333333333333333',
    size:'80x80mm',
    frameColour:'Oak',
    quantity:1,
    photoSetCount,
    photoCount:photoSetCount * 3,
    uploadReference:photoSetCount ? uploadReference : '',
    price:1,
    ...overrides
  };
}

test('legacy eight-photo carts keep their $64.95 price and client-supplied shipping is ignored', () => {
  const lineItems = buildLineItems([
    frameWithPictures(),
    { price_data: { product_data: { name: 'Shipping' } }, quantity: 99 }
  ]);

  assert.deepEqual(lineItems.map(item => item.unitAmount), [6495]);
  assert.deepEqual(lineItems.map(item => item.name), ['Frame + Eight Photos']);
  assert.equal(lineItems.filter(item => item.name === 'Shipping').length, 0);
  assert.throws(() => buildLineItems([frameOnly()]), /invalid product type/);
});

test('variable photo-set pricing is calculated on the server from $50 plus $6 per set', () => {
  const lineItems = [0, 1, 2, 3, 4, 5].map(photoSetCount => (
    buildLineItems([frameWithPhotoSets(photoSetCount)])[0]
  ));
  assert.deepEqual(lineItems.map(item => item.unitAmount), [5000, 5600, 6200, 6800, 7400, 8000]);
  assert.deepEqual(lineItems.map(item => item.name), [
    'Frame Only',
    'Frame + 3 Photos',
    'Frame + 6 Photos',
    'Frame + 9 Photos',
    'Frame + 12 Photos',
    'Frame + 15 Photos'
  ]);
  assert.throws(() => buildLineItems([frameWithPhotoSets(2, { photoCount:3 })]), /photo count does not match/);
  assert.throws(() => buildLineItems([frameWithPhotoSets(1, { uploadReference:'' })]), /completed photo upload reference/);
  assert.throws(() => buildLineItems([frameWithPhotoSets(0, { uploadReference })]), /frame-only product cannot include/);
});

test('Stripe receives the server-calculated variable total and photo counts', () => {
  const lineItems = buildLineItems([frameWithPhotoSets(4)]).map(item => ({ ...item, productCode:'73194' }));
  const payload = createStripePayload(lineItems, 'https://goodframe.com.au', 'live', 'co_0123456789abcdef0123456789abcdef');
  assert.equal(payload.get('line_items[0][price_data][unit_amount]'), '7400');
  assert.equal(payload.get('line_items[0][price_data][product_data][name]'), 'Frame + 12 Photos');
  assert.equal(payload.get('line_items[0][price_data][product_data][metadata][photo_set_count]'), '4');
  assert.equal(payload.get('line_items[0][price_data][product_data][metadata][photo_count]'), '12');
});

test('picture products require a valid upload reference', () => {
  assert.throws(
    () => buildLineItems([frameWithPictures({ uploadReference: '' })]),
    /completed photo upload reference/
  );
});

test('Stripe payload contains safe Tiny Frame metadata and storefront return URLs', () => {
  const lineItems = buildLineItems([frameWithPictures()]).map(item => (
    item.cartItemId ? { ...item, productCode:'19472' } : item
  ));
  const payload = createStripePayload(lineItems, 'https://goodframe.com.au', 'live', 'co_0123456789abcdef0123456789abcdef');

  assert.equal(payload.get('line_items[0][price_data][unit_amount]'), '6495');
  assert.equal(payload.has('line_items[1][price_data][unit_amount]'), false);
  assert.equal(payload.get('shipping_options[0][shipping_rate_data][fixed_amount][amount]'), '1000');
  assert.equal(payload.get('shipping_address_collection[allowed_countries][0]'), 'AU');
  assert.equal(payload.get('line_items[0][price_data][product_data][name]'), 'Frame + Eight Photos');
  assert.equal(payload.has('line_items[0][price_data][product_data][description]'), false);
  assert.equal(payload.get('line_items[0][price_data][product_data][metadata][product_type]'), 'tiny_frame_8_pictures');
  assert.equal(payload.get('line_items[0][price_data][product_data][metadata][frame_colour]'), 'Walnut');
  assert.equal(payload.get('line_items[0][price_data][product_data][metadata][upload_reference]'), uploadReference);
  assert.equal(payload.get('line_items[0][price_data][product_data][metadata][upload_session_id]'), uploadReference);
  assert.equal(payload.get('line_items[0][price_data][product_data][metadata][product_code]'), '19472');
  assert.equal(payload.get('metadata[product_codes]'), '19472');
  assert.equal(payload.get('payment_intent_data[metadata][product_codes]'), '19472');
  const productMap = '1:19472 | Walnut | Frame + Eight Photos | AUD 64.95 | PDF 19472/19472-print-sheet.pdf';
  assert.equal(payload.get('metadata[product_map]'), productMap);
  assert.equal(payload.get('payment_intent_data[metadata][product_map]'), productMap);
  assert.equal(payload.get('payment_intent_data[metadata][frame_colours]'), 'Walnut');
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
  const statusResponse = await worker.fetch(new Request(
    `https://worker.example/tiny-frame-pdf/status?cart_item_id=${pictureCartItemId}&product_code=${result.productCode}`,
    { headers:{ Origin:'https://goodframe.com.au' } }
  ), env);
  assert.equal(statusResponse.status, 200);
  assert.deepEqual(await statusResponse.json(), {
    success:true,
    recovered:true,
    productCode:result.productCode,
    pdf:{
      filename:`${result.productCode}-print-sheet.pdf`,
      objectKey:result.pdf.objectKey,
      size:stored.bytes.byteLength
    }
  });
  const unrelatedStatus = await worker.fetch(new Request(
    `https://worker.example/tiny-frame-pdf/status?cart_item_id=ci_ffffffffffffffffffffffffffffffff&product_code=${result.productCode}`,
    { headers:{ Origin:'https://goodframe.com.au' } }
  ), env);
  assert.equal(unrelatedStatus.status, 404);
  database.close();
});

test('variable multi-page PDF upload stores and validates the declared photo-set count', async () => {
  const bucket = new MemoryR2Bucket();
  const database = createProductCodeDatabase();
  const env = {
    ARTWORK_BUCKET:bucket,
    PRODUCT_CODES_DB:database,
    ALLOWED_ORIGINS:'https://goodframe.com.au'
  };
  const response = await worker.fetch(variableProductPdfRequest(4), env);
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.success, true);
  const stored = bucket.objects.get('73194/73194-print-sheet.pdf');
  assert.equal(stored.customMetadata.product_type, 'tiny_frame_photo_sets');
  assert.equal(stored.customMetadata.photo_set_count, '4');
  assert.equal(stored.customMetadata.image_count, '12');
  const text = new TextDecoder('latin1').decode(stored.bytes);
  assert.equal((text.match(/\/MediaBox \[0 0 595\.275591 841\.889764\]/g) || []).length, 2);
  assert.equal((text.match(/\/Subtype \/Image/g) || []).length, 12);
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

test('multipart upload preserves a large generated A4 PDF byte-for-byte', async () => {
  const bucket = new MemoryR2Bucket();
  const database = createProductCodeDatabase();
  const testEnv = {
    ARTWORK_BUCKET:bucket,
    PRODUCT_CODES_DB:database,
    ALLOWED_ORIGINS:'https://goodframe.com.au'
  };
  const productCode = '58321';
  const largeJpeg = new Uint8Array(1150 * 1024);
  largeJpeg.set(fakeJpeg());
  largeJpeg.set([0xff, 0xd9], largeJpeg.length - 2);
  const pdfBytes = createA4PrintSheetPdf(
    Array.from({ length:8 }, () => ({ bytes:largeJpeg })),
    { productCode }
  );
  assert.ok(pdfBytes.byteLength > 8 * 1024 * 1024);

  const createdResponse = await worker.fetch(multipartRequest('/tiny-frame-pdf/multipart/create', {
    cartItemId:pictureCartItemId,
    productCode,
    frameColour:'Oak',
    fileSize:pdfBytes.byteLength
  }), testEnv);
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  assert.equal(created.partSize, 8 * 1024 * 1024);
  assert.equal(created.partCount, 2);

  const parts = [];
  for (let index = 0; index < created.partCount; index += 1) {
    const start = index * created.partSize;
    const end = Math.min(pdfBytes.byteLength, start + created.partSize);
    const parameters = new URLSearchParams({
      cart_item_id:pictureCartItemId,
      product_code:productCode,
      upload_id:created.uploadId,
      file_size:String(pdfBytes.byteLength),
      part_number:String(index + 1)
    });
    const partResponse = await worker.fetch(multipartRequest(
      `/tiny-frame-pdf/multipart/part?${parameters}`,
      pdfBytes.slice(start, end),
      'application/octet-stream'
    ), testEnv);
    assert.equal(partResponse.status, 200);
    const part = await partResponse.json();
    parts.push({ partNumber:part.partNumber, etag:part.etag });
  }

  const completedResponse = await worker.fetch(multipartRequest('/tiny-frame-pdf/multipart/complete', {
    cartItemId:pictureCartItemId,
    productCode,
    uploadId:created.uploadId,
    fileSize:pdfBytes.byteLength,
    parts
  }), testEnv);
  assert.equal(completedResponse.status, 200);
  const completed = await completedResponse.json();
  assert.equal(completed.success, true);
  assert.equal(completed.pdf.objectKey, `${productCode}/${productCode}-print-sheet.pdf`);
  const stored = bucket.objects.get(completed.pdf.objectKey);
  assert.equal(Buffer.compare(Buffer.from(stored.bytes), Buffer.from(pdfBytes)), 0);
  assert.equal(stored.customMetadata.expected_size, String(pdfBytes.byteLength));

  const retryResponse = await worker.fetch(multipartRequest('/tiny-frame-pdf/multipart/complete', {
    cartItemId:pictureCartItemId,
    productCode,
    uploadId:created.uploadId,
    fileSize:pdfBytes.byteLength,
    parts
  }), testEnv);
  assert.equal(retryResponse.status, 200);
  assert.equal((await retryResponse.json()).retry_recovered, true);
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

test('photo products receive unique persistent codes in one assignment request', async () => {
  const database = createProductCodeDatabase();
  const env = {
    PRODUCT_CODES_DB:database,
    ALLOWED_ORIGINS:'https://goodframe.com.au'
  };
  const firstId = 'ci_cccccccccccccccccccccccccccccccc';
  const secondId = 'ci_dddddddddddddddddddddddddddddddd';
  const first = await (await worker.fetch(assignProductCodeRequest(firstId, 'tiny_frame_8_pictures', '58321'), env)).json();
  const firstRetry = await (await worker.fetch(assignProductCodeRequest(firstId, 'tiny_frame_8_pictures', '58321'), env)).json();
  const second = await (await worker.fetch(assignProductCodeRequest(secondId, 'tiny_frame_8_pictures', '19472'), env)).json();
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

test('browser PDF builder creates two A4 pages for twelve full-resolution photos', async () => {
  const blobs = Array.from({ length:12 }, () => new Blob([fakeJpeg(2160, 3440)], { type:'image/jpeg' }));
  const pdf = await globalThis.GoodFramePrintSheet.createA4PrintSheetPdf(blobs, { productCode:'73194' });
  const text = new TextDecoder('latin1').decode(await pdf.arrayBuffer());
  assert.equal((text.match(/\/MediaBox \[0 0 595\.275591 841\.889764\]/g) || []).length, 2);
  assert.equal((text.match(/\/Subtype \/Image/g) || []).length, 12);
  assert.equal((text.match(/\(PRODUCT 73194\) Tj/g) || []).length, 2);
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
