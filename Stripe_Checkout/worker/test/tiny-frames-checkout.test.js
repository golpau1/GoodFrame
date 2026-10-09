import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker, {
  buildLineItems,
  claimWebhookEvent,
  cleanupPendingUploads,
  createStripePayload,
  markUploadSessionsPaid
} from '../src/index.js';
import { createA4PrintSheetPdf } from '../src/print-sheet-pdf.js';
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
  assert.match(html, /controller\.abort\(\), 300000/);
  assert.match(html, /\/tiny-frame-upload\/original/);
  assert.match(html, /\/tiny-frame-upload\/finalize/);
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
    cropMarkLengthMm:2
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
    return stored ? { key, customMetadata:stored.customMetadata } : null;
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

function jpegDimensions(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return { height:(view[7] << 8) | view[8], width:(view[9] << 8) | view[10] };
}

class MockImagesBinding {
  async info(bytes) {
    return jpegDimensions(bytes);
  }
  input(bytes) {
    const source = jpegDimensions(bytes);
    const state = { width:source.width, height:source.height };
    const handle = {
      transform(options = {}) {
        if (options.trim) {
          state.width -= Number(options.trim.left || 0) + Number(options.trim.right || 0);
          state.height -= Number(options.trim.top || 0) + Number(options.trim.bottom || 0);
        }
        if (options.rotate === 90 || options.rotate === 270) {
          [state.width, state.height] = [state.height, state.width];
        }
        return handle;
      },
      async output() {
        return {
          response:() => new Response(fakeJpeg(state.width, state.height), {
            status:200,
            headers:{ 'Content-Type':'image/jpeg' }
          })
        };
      }
    };
    return handle;
  }
}

function uploadPrintSheetRequest({
  imageCount = 8,
  sessionId = uploadReference,
  frameColour = 'Oak',
  width = 1080,
  height = 1720,
  crops,
  contentTypes = Array.from({ length:imageCount }, () => 'image/jpeg')
} = {}) {
  const form = new FormData();
  form.append('upload_session_id', sessionId);
  form.append('frame_colour', frameColour);
  form.append('image_count', String(imageCount));
  const cropMetadata = crops || Array.from({ length:8 }, () => ({
    x:0,
    y:0,
    width,
    height,
    sourceWidth:width,
    sourceHeight:height,
    rotation:0
  }));
  form.append('crop_metadata', JSON.stringify(cropMetadata));
  for (let index = 0; index < imageCount; index += 1) {
    const type = contentTypes[index] || 'image/jpeg';
    const extension = type === 'image/png' ? 'png' : type === 'image/gif' ? 'gif' : 'jpg';
    form.append(`original_${index + 1}`, new File(
      [fakeJpeg(width, height)],
      `original-${index + 1}.${extension}`,
      { type }
    ));
  }
  return new Request('https://worker.example/upload-print-sheet', {
    method:'POST',
    headers: { Origin:'https://goodframe.com.au' },
    body:form
  });
}

function stagedOriginalRequest({
  sessionId = uploadReference,
  pictureNumber = 1,
  width = 1080,
  height = 1720,
  contentType = 'image/jpeg'
} = {}) {
  const extension = contentType === 'image/png' ? 'png' : contentType === 'image/gif' ? 'gif' : 'jpg';
  const form = new FormData();
  form.append('upload_session_id', sessionId);
  form.append('picture_number', String(pictureNumber));
  form.append('file', new File(
    [fakeJpeg(width, height)],
    `original-${pictureNumber}.${extension}`,
    { type:contentType }
  ));
  return new Request('https://worker.example/tiny-frame-upload/original', {
    method:'POST',
    headers:{ Origin:'https://goodframe.com.au' },
    body:form
  });
}

function stagedFinalizeRequest({
  sessionId = uploadReference,
  frameColour = 'Oak',
  width = 1080,
  height = 1720,
  originalObjectKeys,
  crops
} = {}) {
  return new Request('https://worker.example/tiny-frame-upload/finalize', {
    method:'POST',
    headers:{ Origin:'https://goodframe.com.au', 'Content-Type':'application/json' },
    body:JSON.stringify({
      uploadSessionId:sessionId,
      frameColour,
      originalObjectKeys:originalObjectKeys || Array.from(
        { length:8 },
        (_, index) => `tinyframes/${sessionId}/originals/${String(index + 1).padStart(2, '0')}.jpg`
      ),
      crops:crops || Array.from({ length:8 }, () => ({
        x:0, y:0, width, height, sourceWidth:width, sourceHeight:height, rotation:0
      }))
    })
  });
}

async function uploadStagedOriginals(env, options = {}) {
  const keys = [];
  for (let index = 0; index < 8; index += 1) {
    const contentType = options.contentTypes?.[index] || 'image/jpeg';
    const response = await worker.fetch(stagedOriginalRequest({
      pictureNumber:index + 1,
      width:options.width,
      height:options.height,
      contentType
    }), env);
    assert.equal(response.status, 200);
    keys.push((await response.json()).original.objectKey);
  }
  return keys;
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
  assert.equal(payload.get('line_items[0][price_data][product_data][metadata][product_type]'), 'tiny_frame_only');
  assert.equal(payload.get('line_items[1][price_data][product_data][metadata][product_type]'), 'tiny_frame_8_pictures');
  assert.equal(payload.get('line_items[1][price_data][product_data][metadata][frame_colour]'), 'Walnut');
  assert.equal(payload.get('line_items[1][price_data][product_data][metadata][upload_reference]'), uploadReference);
  assert.equal(payload.get('line_items[1][price_data][product_data][metadata][upload_session_id]'), uploadReference);
  assert.equal(payload.get('line_items[0][price_data][product_data][metadata][product_code]'), '58321');
  assert.equal(payload.get('line_items[1][price_data][product_data][metadata][product_code]'), '19472');
  assert.equal(payload.get('metadata[product_codes]'), '58321,19472');
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
  const env = { ARTWORK_BUCKET:bucket, IMAGES:new MockImagesBinding(), ALLOWED_ORIGINS:'https://goodframe.com.au' };
  const response = await worker.fetch(uploadPrintSheetRequest(), env);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.success, true);
  assert.equal(result.upload_session_id, uploadReference);
  assert.equal(result.print_sheet.filename, 'print-sheet-a4.pdf');
  assert.equal(result.print_sheet.objectKey, `tinyframes/${uploadReference}/print-sheet-a4.pdf`);
  assert.equal(result.image_quality.length, 8);
  assert.equal(result.image_quality.every(item => item.effective_ppi >= 300), true);
  assert.deepEqual(result.warnings, []);
  const storedPrintSheet = bucket.objects.get(result.print_sheet.objectKey);
  assert.deepEqual(storedPrintSheet.customMetadata, {
    upload_session_id:uploadReference,
    product_type:'frame_8_pictures',
    frame_colour:'oak',
    image_count:'8',
    photo_width_mm:'54',
    photo_height_mm:'86',
    status:'pending',
    created_at:storedPrintSheet.customMetadata.created_at
  });
  assert.match(storedPrintSheet.customMetadata.created_at, /^\d{4}-\d{2}-\d{2}T/);
  const manifestKey = `tinyframes/${uploadReference}/manifest.json`;
  assert.equal(bucket.objects.size, 18);
  const manifest = await (await bucket.get(manifestKey)).json();
  assert.equal(manifest.status, 'pending');
  assert.equal(manifest.frame_colour, 'Oak');
  assert.equal(manifest.product_type, 'frame_8_pictures');
  assert.equal(manifest.image_count, 8);
  assert.equal(manifest.print_sheet_filename, 'print-sheet-a4.pdf');
  assert.equal(manifest.print_sheet_object_key, `tinyframes/${uploadReference}/print-sheet-a4.pdf`);
  assert.deepEqual(manifest.page_size_mm, { width:210, height:297 });
  assert.equal(manifest.photo_width_mm, 54);
  assert.equal(manifest.photo_height_mm, 86);
  assert.deepEqual(manifest.photo_size_mm, { width:54, height:86 });
  assert.deepEqual(manifest.cutting_guides, {
    line_width_pt:0.25,
    colour:'light-grey',
    crop_mark_gap_mm:2.5,
    crop_mark_length_mm:2
  });
  assert.equal(manifest.originals.length, 8);
  assert.equal(manifest.originals.every(file => file.size === fakeJpeg().length), true);
  assert.equal(manifest.quality_warning_count, 0);
  assert.equal(manifest.processed_images.length, 8);
  assert.deepEqual(manifest.product_codes, []);
  assert.deepEqual(manifest.print_sheets, []);
  const pdfText = new TextDecoder('latin1').decode(bucket.objects.get(result.print_sheet.objectKey).bytes);
  assert.match(pdfText, /\/MediaBox \[0 0 595\.275591 841\.889764\]/);
  assert.equal((pdfText.match(/\/Subtype \/Image/g) || []).length, 8);
  assert.equal((pdfText.match(/153\.070866 243\.779528/g) || []).length, 8);
  assert.equal((pdfText.match(/153\.070866 243\.779528 re S/g) || []).length, 8);
  assert.match(pdfText, /0\.25 w/);
});

test('offset crops use Cloudflare trim edge offsets and preserve the selected resolution', async () => {
  const bucket = new MemoryR2Bucket();
  const crops = Array.from({ length:8 }, () => ({
    x:100,
    y:50,
    width:1080,
    height:1720,
    sourceWidth:1280,
    sourceHeight:1820,
    rotation:0
  }));
  const response = await worker.fetch(uploadPrintSheetRequest({ width:1280, height:1820, crops }), {
    ARTWORK_BUCKET:bucket,
    IMAGES:new MockImagesBinding(),
    ALLOWED_ORIGINS:'https://goodframe.com.au'
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.image_quality.every(item => item.cropped_width_px === 1080), true);
  assert.equal(result.image_quality.every(item => item.cropped_height_px === 1720), true);
});

test('upload-print-sheet accepts eight PNG originals without using previews as print sources', async () => {
  const bucket = new MemoryR2Bucket();
  const response = await worker.fetch(uploadPrintSheetRequest({
    contentTypes:Array.from({ length:8 }, () => 'image/png')
  }), {
    ARTWORK_BUCKET:bucket,
    IMAGES:new MockImagesBinding(),
    ALLOWED_ORIGINS:'https://goodframe.com.au'
  });
  assert.equal(response.status, 200);
  const manifest = await (await bucket.get(`tinyframes/${uploadReference}/manifest.json`)).json();
  assert.equal(manifest.originals.every(file => file.contentType === 'image/png'), true);
  assert.equal(manifest.originals.every(file => file.objectKey.endsWith('.png')), true);
  assert.equal(manifest.processed_images.every(file => file.contentType === 'image/jpeg'), true);
});

test('upload-print-sheet accepts mixed JPEG and PNG originals', async () => {
  const bucket = new MemoryR2Bucket();
  const contentTypes = Array.from({ length:8 }, (_, index) => index % 2 ? 'image/png' : 'image/jpeg');
  const response = await worker.fetch(uploadPrintSheetRequest({ contentTypes }), {
    ARTWORK_BUCKET:bucket,
    IMAGES:new MockImagesBinding(),
    ALLOWED_ORIGINS:'https://goodframe.com.au'
  });
  assert.equal(response.status, 200);
  const manifest = await (await bucket.get(`tinyframes/${uploadReference}/manifest.json`)).json();
  assert.deepEqual(manifest.originals.map(file => file.contentType), contentTypes);
});

test('large high-resolution crops are not downscaled before PDF generation', async () => {
  const bucket = new MemoryR2Bucket();
  const response = await worker.fetch(uploadPrintSheetRequest({ width:6000, height:9556 }), {
    ARTWORK_BUCKET:bucket,
    IMAGES:new MockImagesBinding(),
    ALLOWED_ORIGINS:'https://goodframe.com.au'
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.image_quality.every(item => item.cropped_width_px === 6000), true);
  assert.equal(result.image_quality.every(item => item.cropped_height_px === 9556), true);
});

test('retrying a completed upload returns the stored result without duplicating R2 objects', async () => {
  const bucket = new MemoryR2Bucket();
  const env = { ARTWORK_BUCKET:bucket, IMAGES:new MockImagesBinding(), ALLOWED_ORIGINS:'https://goodframe.com.au' };
  const first = await worker.fetch(uploadPrintSheetRequest(), env);
  assert.equal(first.status, 200);
  const firstResult = await first.json();
  const storedObjectCount = bucket.objects.size;

  const retry = await worker.fetch(uploadPrintSheetRequest(), env);
  assert.equal(retry.status, 200);
  const retryResult = await retry.json();
  assert.equal(retryResult.retry_recovered, true);
  assert.equal(retryResult.upload_session_id, firstResult.upload_session_id);
  assert.equal(retryResult.print_sheet.objectKey, firstResult.print_sheet.objectKey);
  assert.equal(bucket.objects.size, storedObjectCount);
});

test('staged upload stores each full-resolution original before finalizing processed crops', async () => {
  const bucket = new MemoryR2Bucket();
  const env = { ARTWORK_BUCKET:bucket, IMAGES:new MockImagesBinding(), ALLOWED_ORIGINS:'https://goodframe.com.au' };
  const contentTypes = Array.from({ length:8 }, (_, index) => index % 2 ? 'image/png' : 'image/jpeg');
  const originalObjectKeys = await uploadStagedOriginals(env, { contentTypes });
  assert.equal(bucket.objects.size, 8);

  const response = await worker.fetch(stagedFinalizeRequest({ originalObjectKeys }), env);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.success, true);
  assert.equal(result.manifest.objectKey, `tinyframes/${uploadReference}/manifest.json`);
  assert.equal(bucket.objects.size, 17);
  assert.equal([...bucket.objects.keys()].some(key => key.endsWith('print-sheet-a4.pdf')), false);
  const manifest = await (await bucket.get(result.manifest.objectKey)).json();
  assert.equal(manifest.originals.length, 8);
  assert.deepEqual(manifest.originals.map(file => file.contentType), contentTypes);
  assert.equal(manifest.processed_images.length, 8);
  assert.equal(manifest.files.length, 16);
});

test('staged upload retries reuse stored originals and recover without reselecting files', async () => {
  const bucket = new MemoryR2Bucket();
  const env = { ARTWORK_BUCKET:bucket, IMAGES:new MockImagesBinding(), ALLOWED_ORIGINS:'https://goodframe.com.au' };
  const first = await worker.fetch(stagedOriginalRequest(), env);
  assert.equal(first.status, 200);
  const firstResult = await first.json();
  const storedCount = bucket.objects.size;
  const retry = await worker.fetch(stagedOriginalRequest(), env);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).retry_recovered, true);
  assert.equal(bucket.objects.size, storedCount);

  const originalObjectKeys = [
    firstResult.original.objectKey,
    ...(await uploadStagedOriginals(env)).slice(1)
  ];
  const badCrops = Array.from({ length:8 }, () => ({
    x:0, y:0, width:1080, height:1720, sourceWidth:1200, sourceHeight:1720, rotation:0
  }));
  const failedFinalize = await worker.fetch(stagedFinalizeRequest({ originalObjectKeys, crops:badCrops }), env);
  assert.equal(failedFinalize.status, 400);
  assert.equal(bucket.objects.has(originalObjectKeys[0]), true);

  const recovered = await worker.fetch(stagedFinalizeRequest({ originalObjectKeys }), env);
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).success, true);
});

test('upload-print-sheet rejects a sheet that does not represent eight crops', async () => {
  const bucket = new MemoryR2Bucket();
  const response = await worker.fetch(uploadPrintSheetRequest({ imageCount:7 }), {
    ARTWORK_BUCKET:bucket,
    IMAGES:new MockImagesBinding(),
    ALLOWED_ORIGINS:'https://goodframe.com.au'
  });
  assert.equal(response.status, 400);
  assert.equal(bucket.objects.size, 0);
});

test('upload-print-sheet rejects crop data that does not match the original dimensions', async () => {
  const bucket = new MemoryR2Bucket();
  const crops = Array.from({ length:8 }, () => ({
    x:0, y:0, width:1080, height:1720, sourceWidth:1200, sourceHeight:1720, rotation:0
  }));
  const response = await worker.fetch(uploadPrintSheetRequest({ crops }), {
    ARTWORK_BUCKET:bucket,
    IMAGES:new MockImagesBinding(),
    ALLOWED_ORIGINS:'https://goodframe.com.au'
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /does not match its saved crop information/);
  assert.equal(bucket.objects.size, 0);
});

test('upload-print-sheet rejects a crop with the wrong print ratio', async () => {
  const bucket = new MemoryR2Bucket();
  const crops = Array.from({ length:8 }, () => ({
    x:0, y:0, width:1000, height:1000, sourceWidth:1080, sourceHeight:1720, rotation:0
  }));
  const response = await worker.fetch(uploadPrintSheetRequest({
    crops
  }), {
    ARTWORK_BUCKET:bucket,
    IMAGES:new MockImagesBinding(),
    ALLOWED_ORIGINS:'https://goodframe.com.au'
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /54 x 86 mm print ratio/);
  assert.equal(bucket.objects.size, 0);
});

test('upload-print-sheet reports cropped images below 200 PPI without upscaling them', async () => {
  const bucket = new MemoryR2Bucket();
  const response = await worker.fetch(uploadPrintSheetRequest({ width:270, height:430 }), {
    ARTWORK_BUCKET:bucket,
    IMAGES:new MockImagesBinding(),
    ALLOWED_ORIGINS:'https://goodframe.com.au'
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.image_quality.every(item => item.below_200_ppi), true);
  assert.equal(result.warnings.length, 8);
  const manifest = await (await bucket.get(`tinyframes/${uploadReference}/manifest.json`)).json();
  assert.equal(manifest.quality_warning_count, 8);
  assert.equal(manifest.originals[0].cropped_width_px, 270);
  assert.equal(manifest.originals[0].cropped_height_px, 430);
});

test('paid Stripe sessions promote pending upload manifests', async () => {
  const bucket = new MemoryR2Bucket();
  const env = { ARTWORK_BUCKET:bucket, IMAGES:new MockImagesBinding(), ALLOWED_ORIGINS:'https://goodframe.com.au' };
  assert.equal((await worker.fetch(uploadPrintSheetRequest(), env)).status, 200);
  assert.equal(await markUploadSessionsPaid({
    id:'cs_test_tiny_frame_paid',
    metadata:{ upload_session_ids:uploadReference }
  }, env), 1);
  const manifest = await (await bucket.get(`tinyframes/${uploadReference}/manifest.json`)).json();
  assert.equal(manifest.status, 'paid');
  assert.equal(manifest.stripe_checkout_session_id, 'cs_test_tiny_frame_paid');
  assert.match(manifest.paid_at, /^\d{4}-\d{2}-\d{2}T/);
  const printSheet = bucket.objects.get(`tinyframes/${uploadReference}/print-sheet-a4.pdf`);
  assert.equal(printSheet.customMetadata.status, 'paid');
  assert.equal(printSheet.customMetadata.stripe_checkout_session_id, 'cs_test_tiny_frame_paid');
  assert.equal(printSheet.customMetadata.paid_at, manifest.paid_at);
  for (let index = 1; index <= 8; index += 1) {
    const original = bucket.objects.get(`tinyframes/${uploadReference}/originals/${String(index).padStart(2, '0')}.jpg`);
    assert.equal(original.customMetadata.status, 'paid');
    assert.equal(original.customMetadata.stripe_checkout_session_id, 'cs_test_tiny_frame_paid');
  }
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
