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
import { createProductCodeDatabase } from './helpers/d1.js';

const uploadReference = 'tf_0123456789abcdef0123456789abcdef';

test('storefront uploads cropped photos individually in the background', async () => {
  const html = await readFile(new URL('../../../index.html', import.meta.url), 'utf8');
  assert.match(html, /const frameAspectRatio = 54 \/ 86;/);
  assert.match(html, /const CROP_SOURCE_MAX_DIMENSION = 4096;/);
  assert.match(html, /function createCropSourceUrl\(file, maximumDimension = CROP_SOURCE_MAX_DIMENSION\)/);
  assert.match(html, /maximumDimension \/ sourceImage\.naturalWidth/);
  assert.match(html, /item\.sourceUrl \|\|= await createCropSourceUrl\(item\.file\)/);
  assert.match(html, /const PRINT_JPEG_QUALITY = \.98;/);
  assert.doesNotMatch(html, /PRINT_EXPORT_SHORT_EDGE/);
  assert.match(html, /canvasToJpegBlob\(printCanvas, PRINT_JPEG_QUALITY\)/);
  assert.match(html, /const uploadedImages = Array\(3\)\.fill\(null\);/);
  assert.match(html, /for \(let offset = 0; offset < 3; offset \+= 1\)/);
  assert.match(html, /input\.multiple = true;/);
  assert.match(html, /MAX_CONCURRENT_PHOTO_UPLOADS = 2/);
  assert.match(html, /\/tiny-frame-upload\/session/);
  assert.match(html, /\/tiny-frame-upload\/photo/);
  assert.match(html, /\/tiny-frame-upload\/finalize/);
  assert.match(html, /uploadState:\"processing\"/);
  assert.match(html, /PHOTO_UPLOAD_REQUEST_TIMEOUT_MS/);
  assert.match(html, /fetchWithUploadTimeout/);
  assert.match(html, /cache:"no-store"/);
  assert.match(html, /credentials:"omit"/);
  assert.match(html, /readUploadJson/);
  assert.match(html, /PHOTO_UPLOAD_MAX_ATTEMPTS = 5/);
  assert.match(html, /waitForUploadRetry/);
  assert.match(html, /let individualUploadSessionRecoveryPromise = null;/);
  assert.match(html, /function isUploadSessionRecoveryError\(error\)/);
  assert.match(html, /async function recoverIndividualUploadSession\(staleSession\)/);
  assert.match(html, /return synchronizeActivePhotoSelectionNow\(true\);/);
  assert.match(html, /if \(!authRecoveryAttempted && isUploadSessionRecoveryError\(error\)\)/);
  assert.match(html, /if \(!isRetryableUploadStatus\(response\.status\)\) break;/);
  assert.match(html, /if \(individualUploadSession && individualUploadSessionRegistered\) return individualUploadSession;/);
  const restoreSessionIndex = html.indexOf('await registerIndividualUploadSession(draft.session, 1);');
  const restoreStatusIndex = html.indexOf('const parameters = new URLSearchParams({ upload_session_id:draft.session.uploadSessionId });');
  assert.ok(restoreSessionIndex >= 0 && restoreSessionIndex < restoreStatusIndex);
  assert.match(html, /\.catch\(\(error\) => failIndividualPhotoUpload\(entry, error\)\)/);
  assert.match(html, /Upload failed · Retry/);
  assert.match(html, /entry\?\.uploadState === \"complete\"/);
  assert.match(html, /finalizeIndividualUploads\(uploadedImages, FRAME_COLOUR\)/);
  assert.match(html, /photoFiles:uploadSession\.photos/);
  assert.doesNotMatch(html, /<script src=\"print-sheet\.js\"><\/script>/);
  assert.doesNotMatch(html, /GoodFramePrintSheet/);
  assert.doesNotMatch(html, /\/tiny-frame-pdf\/upload/);
  assert.match(html, /entry\?\.previewBlob instanceof Blob \? entry\.previewBlob : entry\?\.printBlob/);
  assert.match(html, /const previewScale = Math\.min\(1, 1200 \/ crop\.width, 1200 \/ crop\.height\);/);
  assert.match(html, /function prepareIndividualPhotoForUpload\(entry, delay = 0\)/);
  assert.match(html, /const prepared = await createPrintCropBlob\(entry\);/);
  assert.match(html, /crop\.rotation === 90 \? rotateCanvasClockwise\(croppedCanvas\) : croppedCanvas/);
  assert.match(html, /id=\"cropper-progress-label\">Photo 1 of 1/);
  assert.match(html, /function startCropBatch\(files, slotIndices, returnFocus\)/);
  assert.match(html, /selectedFiles\.slice\(0, targetSlots\.length\)/);
  assert.match(html, /function appendPhotoSet\(setIndex\)/);
  assert.match(html, /function preserveScrollDuringLayoutChange/);
  assert.match(html, /id=\"product-name\">Natural Oak Frame &amp; Photos</);
  assert.match(html, /const FRAME_COLOUR = \"Natural Oak\";/);
  assert.match(html, /frameColour:FRAME_COLOUR,/);
  assert.doesNotMatch(html, /swatch-button|data-colour/);
  assert.match(html, /"price": "50\.00"/);
  assert.match(html, /const BASE_FRAME_PRICE = 50;/);
  assert.match(html, /const PHOTO_SET_PRICE = 5;/);
  assert.match(html, /function photoSetPriceFor\(photoSetCount\) \{\s*return BASE_FRAME_PRICE \+ \(Math\.max\(0, photoSetCount - 1\) \* PHOTO_SET_PRICE\);/);
  assert.match(html, /id=\"config-price\">50\.00</);
  assert.match(html, /id=\"add-photo-set\"[^>]*>\+ Add Another 3 Photos — \$5</);
  assert.match(html, /\.photo-sets \{ display:grid; height:auto; gap:22px; overflow:visible; \}/);
  assert.match(html, /\.configurator \{ width:min\(60%,350px\); height:auto; max-height:none;/);
  assert.match(html, /hero-dscf1744-effect-landscape-2560\.webp/);
  assert.match(html, /hero-dscf1744-effect-portrait-960\.webp/);
  assert.match(html, /Upload Photos/);
  assert.match(html, /id="upload-progress" role="status" aria-live="polite"/);
  assert.match(html, /your selected \$\{failedCount === 1 \? "photo is" : "photos are"\} still saved/);
  assert.match(html, /replace\.addEventListener\("click", \(\) => triggerSlotPicker\(slot, replace\)\);/);
  assert.match(html, /uploadedImages\[item\.slotIndex\] = entry;/);
  assert.doesNotMatch(html, /image-remove-button/);
  assert.doesNotMatch(html, /slot-move-button/);
  assert.doesNotMatch(html, /function movePhoto/);
  const cropNavigation = html.slice(
    html.indexOf('async function moveThroughCropBatch(direction)'),
    html.indexOf('backCropButton.addEventListener')
  );
  assert.match(cropNavigation, /void persistDraftUploads\(\);/);
  assert.match(cropNavigation, /void prepareIndividualPhotoForUpload\(entry, finishing \? 170 : 40\);/);
  assert.doesNotMatch(cropNavigation, /await persistDraftUploads\(\)/);
  assert.doesNotMatch(cropNavigation, /await synchronizeActivePhotoSelection\(\)/);
  assert.match(cropNavigation, /cropBatch\.committed = true;\s*closeCropper\(\{ smooth:true \}\);/);
});

test('stale and malformed upload credentials return recoverable authentication codes', async () => {
  const bucket = new MemoryR2Bucket();
  const database = createProductCodeDatabase();
  const env = {
    ARTWORK_BUCKET:bucket,
    PRODUCT_CODES_DB:database,
    ALLOWED_ORIGINS:'https://goodframe.com.au'
  };
  const uploadSessionId = `tf_${'7'.repeat(32)}`;
  const uploadToken = `ut_${'8'.repeat(64)}`;
  const cartItemId = `ci_${'9'.repeat(32)}`;
  const sessionRequest = () => new Request('https://worker.example/tiny-frame-upload/session', {
    method:'POST',
    headers:{ Origin:'https://goodframe.com.au', 'Content-Type':'application/json' },
    body:JSON.stringify({ uploadSessionId, uploadToken, cartItemId })
  });
  assert.equal((await worker.fetch(sessionRequest(), env)).status, 200);

  const selectionBody = JSON.stringify({
    uploadSessionId,
    cartItemId,
    selectionVersion:0,
    photoSetCount:1,
    frameColour:'Natural Oak',
    selection:[null, null, null]
  });
  const staleResponse = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/selection', {
    method:'POST',
    headers:{
      Origin:'https://goodframe.com.au',
      'Content-Type':'application/json',
      'X-Upload-Token':`ut_${'a'.repeat(64)}`
    },
    body:selectionBody
  }), env);
  assert.equal(staleResponse.status, 400);
  assert.deepEqual(await staleResponse.json(), {
    error:'Upload session could not be authenticated',
    code:'UPLOAD_SESSION_AUTH_FAILED'
  });

  const malformedResponse = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/selection', {
    method:'POST',
    headers:{
      Origin:'https://goodframe.com.au',
      'Content-Type':'application/json',
      'X-Upload-Token':'outdated-token'
    },
    body:selectionBody
  }), env);
  assert.equal(malformedResponse.status, 400);
  assert.equal((await malformedResponse.json()).code, 'UPLOAD_SESSION_INVALID');

  database.prepare("UPDATE photo_upload_sessions SET status = 'expired' WHERE upload_session_id = ?")
    .bind(uploadSessionId).run();
  const expiredResponse = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/selection', {
    method:'POST',
    headers:{
      Origin:'https://goodframe.com.au',
      'Content-Type':'application/json',
      'X-Upload-Token':uploadToken
    },
    body:selectionBody
  }), env);
  assert.equal(expiredResponse.status, 400);
  assert.equal((await expiredResponse.json()).code, 'UPLOAD_SESSION_EXPIRED');

  const conflictResponse = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/session', {
    method:'POST',
    headers:{ Origin:'https://goodframe.com.au', 'Content-Type':'application/json' },
    body:JSON.stringify({ uploadSessionId, uploadToken:`ut_${'b'.repeat(64)}`, cartItemId })
  }), env);
  assert.equal(conflictResponse.status, 409);
  assert.equal((await conflictResponse.json()).code, 'UPLOAD_SESSION_CONFLICT');
  database.close();
});

test('individual photo upload CORS allows configured storefront origins and readable Worker errors', async () => {
  const bucket = new MemoryR2Bucket();
  const database = createProductCodeDatabase();
  const storageFolders = [];
  const origins = [
    'https://goodframe.com.au',
    'https://www.goodframe.com.au',
    'http://localhost:4173',
    'http://127.0.0.1:4173'
  ];
  const env = {
    ARTWORK_BUCKET:bucket,
    PRODUCT_CODES_DB:database,
    ALLOWED_ORIGINS:origins.join(',')
  };

  for (const [index, origin] of origins.entries()) {
    const preflight = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/session', {
      method:'OPTIONS',
      headers:{
        Origin:origin,
        'Access-Control-Request-Method':'POST',
        'Access-Control-Request-Headers':'content-type,x-upload-token,x-upload-attempt'
      }
    }), env);
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'GET,POST,DELETE,OPTIONS');
    assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /Content-Type/i);
    assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /X-Upload-Token/i);
    assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /X-Upload-Attempt/i);
    assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), null);

    const uploadSessionId = `tf_${String(index + 1).repeat(32)}`;
    const uploadToken = `ut_${String(index + 1).repeat(64)}`;
    const cartItemId = `ci_${String(index + 1).repeat(32)}`;
    const response = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/session', {
      method:'POST',
      headers:{ Origin:origin, 'Content-Type':'application/json' },
      body:JSON.stringify({ uploadSessionId, uploadToken, cartItemId })
    }), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(response.headers.get('Cache-Control'), 'no-store, max-age=0');
    const session = await response.json();
    assert.equal(session.success, true);
    assert.match(session.productCode, /^[1-9]\d{4}$/);
    assert.equal(session.storageFolder, session.productCode);
    storageFolders.push(session.storageFolder);
    const manifest = await bucket.get(`uploads/${session.storageFolder}/manifest.json`);
    assert.ok(manifest, [...bucket.objects.keys()].join(', '));
    const manifestData = await manifest.json();
    assert.equal(manifestData.product_code, session.productCode);
  }
  assert.equal(new Set(storageFolders).size, storageFolders.length);

  const rejectedPreflight = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/session', {
    method:'OPTIONS',
    headers:{
      Origin:'https://attacker.example',
      'Access-Control-Request-Method':'POST',
      'Access-Control-Request-Headers':'content-type'
    }
  }), env);
  assert.equal(rejectedPreflight.status, 403);
  assert.equal(rejectedPreflight.headers.get('Access-Control-Allow-Origin'), null);

  const rejectedHeader = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/session', {
    method:'OPTIONS',
    headers:{
      Origin:origins[0],
      'Access-Control-Request-Method':'POST',
      'Access-Control-Request-Headers':'x-unexpected-header'
    }
  }), env);
  assert.equal(rejectedHeader.status, 403);
  assert.equal(rejectedHeader.headers.get('Access-Control-Allow-Origin'), origins[0]);

  const failingEnv = {
    ...env,
    ARTWORK_BUCKET:{ get:async () => { throw new Error('R2 unavailable'); } }
  };
  const originalConsoleError = console.error;
  const loggedErrors = [];
  console.error = (...args) => loggedErrors.push(args);
  let failedResponse;
  try {
    failedResponse = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/session', {
      method:'POST',
      headers:{ Origin:origins[0], 'Content-Type':'application/json' },
      body:JSON.stringify({
        uploadSessionId:`tf_${'f'.repeat(32)}`,
        uploadToken:`ut_${'f'.repeat(64)}`,
        cartItemId:`ci_${'f'.repeat(32)}`
      })
    }), failingEnv);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(failedResponse.status, 500);
  assert.equal(failedResponse.headers.get('Access-Control-Allow-Origin'), origins[0]);
  assert.equal((await failedResponse.json()).code, 'WORKER_REQUEST_FAILED');
  assert.equal(loggedErrors.length, 1);
  database.close();
});

test('photo upload folders support the longest suffixed time and remain unique in D1', () => {
  const database = createProductCodeDatabase();
  const storageFolder = '26-10-2026_9-36PM-a7b4';
  const insertSession = (uploadSessionId, cartItemId) => database.prepare(
    `INSERT OR IGNORE INTO photo_upload_sessions
      (upload_session_id, cart_item_id, upload_token_hash, status, storage_folder, created_at, updated_at)
     VALUES (?, ?, ?, 'draft', ?, ?, ?)`
  ).bind(
    uploadSessionId,
    cartItemId,
    'a'.repeat(64),
    storageFolder,
    new Date().toISOString(),
    new Date().toISOString()
  ).run();

  assert.equal(storageFolder.length, 22);
  assert.equal(insertSession(`tf_${'1'.repeat(32)}`, `ci_${'1'.repeat(32)}`).meta.changes, 1);
  assert.equal(insertSession(`tf_${'2'.repeat(32)}`, `ci_${'2'.repeat(32)}`).meta.changes, 0);
  database.close();
});

test('individual cropped photos are authenticated, resumable, finalized, and promoted after payment', async () => {
  const bucket = new MemoryR2Bucket();
  const database = createProductCodeDatabase();
  const env = {
    ARTWORK_BUCKET:bucket,
    PRODUCT_CODES_DB:database,
    ADMIN_API_KEY:'admin-key-that-is-at-least-24-characters',
    ALLOWED_ORIGINS:'https://goodframe.com.au',
    STRIPE_MODE:'test',
    STRIPE_TEST_SECRET_KEY:'sk_test_example',
    SITE_BASE_URL:'https://goodframe.com.au',
    IMAGES:{ info:async () => ({ width:1080, height:1720 }) }
  };
  const uploadSessionId = 'tf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const uploadToken = `ut_${'b'.repeat(64)}`;
  const cartItemId = 'ci_cccccccccccccccccccccccccccccccc';
  const headers = { Origin:'https://goodframe.com.au', 'X-Upload-Token':uploadToken };
  const sessionResponse = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/session', {
    method:'POST',
    headers:{ Origin:'https://goodframe.com.au', 'Content-Type':'application/json' },
    body:JSON.stringify({ uploadSessionId, uploadToken, cartItemId })
  }), env);
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  const storageFolder = session.storageFolder;
  const productCode = session.productCode;
  assert.match(productCode, /^[1-9]\d{4}$/);
  assert.equal(storageFolder, productCode);

  const photos = [];
  const selection = [];
  for (let index = 0; index < 3; index += 1) {
    const photoId = `ph_${String(index + 1).repeat(32)}`;
    const revision = `${String(index + 4).repeat(8)}-${String(index + 4).repeat(4)}-${String(index + 4).repeat(4)}-${String(index + 4).repeat(4)}-${String(index + 4).repeat(12)}`;
    selection.push({ photoId, revision });
  }
  const selectionResponse = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/selection', {
    method:'POST',
    headers:{ ...headers, 'Content-Type':'application/json' },
    body:JSON.stringify({
      uploadSessionId,
      cartItemId,
      selectionVersion:0,
      photoSetCount:1,
      frameColour:'Natural Oak',
      selection
    })
  }), env);
  assert.equal(selectionResponse.status, 200);
  for (let index = 0; index < 3; index += 1) {
    const { photoId, revision } = selection[index];
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
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://goodframe.com.au');
    photos.push((await response.json()).photo);
    photos[index].revision = revision;
    assert.equal(photos[index].objectKey, `uploads/${productCode}/photo-${String(index + 1).padStart(2, '0')}.jpg`);
  }
  const retryForm = new FormData();
  retryForm.append('upload_session_id', uploadSessionId);
  retryForm.append('photo_id', selection[0].photoId);
  retryForm.append('revision', selection[0].revision);
  retryForm.append('position', '1');
  retryForm.append('file', new File([fakeJpeg()], 'retry.jpg', { type:'image/jpeg' }));
  const retryUpload = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/photo', {
    method:'POST', headers, body:retryForm
  }), env);
  assert.equal(retryUpload.status, 200);
  const retriedPhoto = await retryUpload.json();
  assert.equal(retriedPhoto.recovered, true);
  assert.equal(retriedPhoto.photo.objectKey, photos[0].objectKey);
  assert.equal((await bucket.list({ prefix:`uploads/${productCode}/photo-` })).objects.length, 3);
  assert.equal((await bucket.list({ prefix:'temporary/' })).objects.length, 0);

  const statusResponse = await worker.fetch(new Request(`https://worker.example/tiny-frame-upload/status?upload_session_id=${uploadSessionId}`, { headers }), env);
  const status = await statusResponse.json();
  assert.equal(status.photos.length, 3);
  assert.deepEqual(status.photos.map(photo => photo.position), [1, 2, 3]);

  const reorderedSelection = selection.slice().reverse();
  const reorderResponse = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/selection', {
    method:'POST',
    headers:{ ...headers, 'Content-Type':'application/json' },
    body:JSON.stringify({
      uploadSessionId,
      cartItemId,
      selectionVersion:1,
      photoSetCount:1,
      frameColour:'Natural Oak',
      selection:reorderedSelection
    })
  }), env);
  assert.equal(reorderResponse.status, 200);
  const restoreOrderResponse = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/selection', {
    method:'POST',
    headers:{ ...headers, 'Content-Type':'application/json' },
    body:JSON.stringify({
      uploadSessionId,
      cartItemId,
      selectionVersion:2,
      photoSetCount:1,
      frameColour:'Natural Oak',
      selection
    })
  }), env);
  assert.equal(restoreOrderResponse.status, 200);

  const finalizeResponse = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/finalize', {
    method:'POST',
    headers:{ ...headers, 'Content-Type':'application/json' },
    body:JSON.stringify({
      uploadSessionId,
      cartItemId,
      frameColour:'Natural Oak',
      photoSetCount:1
    })
  }), env);
  assert.equal(finalizeResponse.status, 200);

  const manifestKey = `uploads/${productCode}/manifest.json`;
  const manifest = await (await bucket.get(manifestKey)).json();
  assert.equal(manifest.storage_folder, storageFolder);
  const originalFetch = globalThis.fetch;
  let stripeBody;
  globalThis.fetch = async (_url, options) => {
    stripeBody = new URLSearchParams(options.body);
    return Response.json({
      id:'cs_test_directproductcode',
      url:'https://checkout.stripe.test/session',
      expires_at:Math.floor(Date.now() / 1000) + 3600
    });
  };
  let checkout;
  try {
    checkout = await worker.fetch(new Request('https://worker.example/create-checkout-session', {
      method:'POST',
      headers:{ Origin:'https://goodframe.com.au', 'Content-Type':'application/json' },
      body:JSON.stringify({
        checkoutRequestId:'co_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01',
        shippingCountry:'AU',
        items:[{
          productType:'tiny_frame_photo_sets',
          cartItemId,
          size:'80x80mm',
          frameColour:'Natural Oak',
          photoSetCount:1,
          photoCount:3,
          quantity:1,
          uploadReference:uploadSessionId
        }]
      })
    }), env);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(checkout.status, 200);
  const checkoutResult = await checkout.json();
  assert.deepEqual(checkoutResult.productCodes, [productCode]);
  assert.equal(
    stripeBody.get('line_items[0][price_data][product_data][metadata][product_code]'),
    productCode
  );
  await markUploadSessionsPaid({
    id:checkoutResult.id,
    metadata:{ upload_session_ids:uploadSessionId }
  }, env);
  const finalManifestKey = `uploads/${productCode}/manifest.json`;
  assert.ok(bucket.objects.has(finalManifestKey));
  const finalManifest = await (await bucket.get(finalManifestKey)).json();
  assert.equal(finalManifest.photo_count, 3);
  assert.equal(finalManifest.photos.length, 3);
  assert.equal(finalManifest.order_code, productCode);
  assert.equal(finalManifest.status, 'paid');
  const paidPhotoKey = finalManifest.photos[0].objectKey;
  assert.equal(paidPhotoKey, photos[0].objectKey);
  const paidPhotoBeforeRetry = new Uint8Array(bucket.objects.get(paidPhotoKey).bytes);
  await markUploadSessionsPaid({
    id:checkoutResult.id,
    metadata:{ upload_session_ids:uploadSessionId }
  }, env);
  assert.deepEqual(new Uint8Array(bucket.objects.get(paidPhotoKey).bytes), paidPhotoBeforeRetry);
  assert.ok(await bucket.get(manifestKey));

  database.prepare(`UPDATE product_codes
    SET stripe_checkout_session_id = ?, status = 'paid', paid_at = ?
    WHERE code = ?`)
    .bind(checkoutResult.id, new Date().toISOString(), productCode)
    .run();
  const adminHeaders = { Authorization:'Bearer admin-key-that-is-at-least-24-characters' };
  const assetResponse = await worker.fetch(new Request(`https://worker.example/admin/product-assets/${productCode}`, { headers:adminHeaders }), env);
  const assets = await assetResponse.json();
  assert.equal(assets.photoCount, 3);
  assert.equal(assets.photos[0].downloadUrl, `/admin/product-assets/${productCode}/photo/1`);
  const downloadResponse = await worker.fetch(new Request(`https://worker.example/admin/product-assets/${productCode}/photo/1`, { headers:adminHeaders }), env);
  assert.equal(downloadResponse.status, 200);
  assert.equal(downloadResponse.headers.get('Content-Type'), 'image/jpeg');
  assert.equal((await downloadResponse.arrayBuffer()).byteLength, fakeJpeg().byteLength);
  database.close();
});

test('a replaced photo cannot become active when its in-flight upload finishes late', async () => {
  const bucket = new MemoryR2Bucket();
  const database = createProductCodeDatabase();
  const uploadSessionId = `tf_${'c'.repeat(32)}`;
  const uploadToken = `ut_${'d'.repeat(64)}`;
  const cartItemId = `ci_${'e'.repeat(32)}`;
  let releaseImageInfo;
  let markImageInfoStarted;
  const imageInfoStarted = new Promise(resolve => { markImageInfoStarted = resolve; });
  const imageInfoGate = new Promise(resolve => { releaseImageInfo = resolve; });
  const env = {
    ARTWORK_BUCKET:bucket,
    PRODUCT_CODES_DB:database,
    ALLOWED_ORIGINS:'https://goodframe.com.au',
    IMAGES:{ info:async () => {
      markImageInfoStarted();
      await imageInfoGate;
      return { width:1080, height:1720 };
    } }
  };
  const authHeaders = { Origin:'https://goodframe.com.au', 'X-Upload-Token':uploadToken };
  const session = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/session', {
    method:'POST',
    headers:{ Origin:'https://goodframe.com.au', 'Content-Type':'application/json' },
    body:JSON.stringify({ uploadSessionId, uploadToken, cartItemId })
  }), env);
  assert.equal(session.status, 200);
  const oldPhoto = { photoId:`ph_${'1'.repeat(32)}`, revision:'11111111-1111-4111-8111-111111111111' };
  const newPhoto = { photoId:`ph_${'2'.repeat(32)}`, revision:'22222222-2222-4222-8222-222222222222' };
  const updateSelection = (selectionVersion, photo) => worker.fetch(new Request(
    'https://worker.example/tiny-frame-upload/selection',
    {
      method:'POST',
      headers:{ ...authHeaders, 'Content-Type':'application/json' },
      body:JSON.stringify({
        uploadSessionId,
        cartItemId,
        selectionVersion,
        photoSetCount:1,
        frameColour:'Natural Oak',
        selection:[photo, null, null]
      })
    }
  ), env);
  assert.equal((await updateSelection(0, oldPhoto)).status, 200);

  const oldForm = new FormData();
  oldForm.append('upload_session_id', uploadSessionId);
  oldForm.append('photo_id', oldPhoto.photoId);
  oldForm.append('revision', oldPhoto.revision);
  oldForm.append('position', '1');
  oldForm.append('file', new File([fakeJpeg()], 'old.jpg', { type:'image/jpeg' }));
  const oldUploadPromise = worker.fetch(new Request('https://worker.example/tiny-frame-upload/photo', {
    method:'POST',
    headers:authHeaders,
    body:oldForm
  }), env);
  await imageInfoStarted;
  assert.equal((await updateSelection(1, newPhoto)).status, 200);
  releaseImageInfo();
  const staleResponse = await oldUploadPromise;
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).code, 'PHOTO_SUPERSEDED');
  assert.equal((await bucket.list({ prefix:`temporary/${uploadSessionId}/photos/` })).objects.length, 0);

  const status = await worker.fetch(new Request(
    `https://worker.example/tiny-frame-upload/status?upload_session_id=${uploadSessionId}`,
    { headers:authHeaders }
  ), env);
  const active = await status.json();
  assert.equal(active.photos.length, 0);
  const removeResponse = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/selection', {
    method:'POST',
    headers:{ ...authHeaders, 'Content-Type':'application/json' },
    body:JSON.stringify({
      uploadSessionId,
      cartItemId,
      selectionVersion:2,
      photoSetCount:1,
      frameColour:'Natural Oak',
      selection:[null, null, null]
    })
  }), env);
  assert.equal(removeResponse.status, 200);
  database.close();
});

test('individual photo sets are not capped at 100 sets or 300 photos', async () => {
  const lineItem = buildLineItems([frameWithPhotoSets(101)])[0];
  assert.equal(lineItem.photoSetCount, 101);
  assert.equal(lineItem.photoCount, 303);
  assert.equal(lineItem.unitAmount, 55000);

  const bucket = new MemoryR2Bucket();
  const database = createProductCodeDatabase();
  const uploadSessionId = 'tf_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const uploadToken = `ut_${'9'.repeat(64)}`;
  const cartItemId = `ci_${'8'.repeat(32)}`;
  const create = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/session', {
    method:'POST',
    headers:{ Origin:'https://goodframe.com.au', 'Content-Type':'application/json' },
    body:JSON.stringify({ uploadSessionId, uploadToken, cartItemId })
  }), { ARTWORK_BUCKET:bucket, PRODUCT_CODES_DB:database, ALLOWED_ORIGINS:'https://goodframe.com.au' });
  assert.equal(create.status, 200);

  const photoId = `ph_${'9'.repeat(32)}`;
  const revision = '99999999-9999-4999-8999-999999999999';
  const selection = Array(303).fill(null);
  selection[300] = { photoId, revision };
  const selectionResponse = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/selection', {
    method:'POST',
    headers:{ Origin:'https://goodframe.com.au', 'Content-Type':'application/json', 'X-Upload-Token':uploadToken },
    body:JSON.stringify({
      uploadSessionId,
      cartItemId,
      selectionVersion:0,
      photoSetCount:101,
      frameColour:'Natural Oak',
      selection
    })
  }), { ARTWORK_BUCKET:bucket, PRODUCT_CODES_DB:database, ALLOWED_ORIGINS:'https://goodframe.com.au' });
  assert.equal(selectionResponse.status, 200);
  const form = new FormData();
  form.append('upload_session_id', uploadSessionId);
  form.append('photo_id', photoId);
  form.append('revision', revision);
  form.append('position', '301');
  form.append('file', new File([fakeJpeg()], `${photoId}.jpg`, { type:'image/jpeg' }));
  const upload = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/photo', {
    method:'POST',
    headers:{ Origin:'https://goodframe.com.au', 'X-Upload-Token':uploadToken },
    body:form
  }), {
    ARTWORK_BUCKET:bucket,
    PRODUCT_CODES_DB:database,
    ALLOWED_ORIGINS:'https://goodframe.com.au',
    IMAGES:{ info:async () => ({ width:1080, height:1720 }) }
  });
  assert.equal(upload.status, 200);
  const uploaded = await upload.json();
  assert.equal((await bucket.head(uploaded.photo.objectKey)).customMetadata.photo_id, photoId);
  assert.equal(uploaded.photo.position, 301);
  database.close();
});

test('Stripe metadata chunks all upload sessions for large multi-product orders', async () => {
  const items = Array.from({ length:16 }, (_, index) => ({
    productCode:String(10001 + index),
    productType:'tiny_frame_photo_sets',
    cartItemId:`ci_${String(index + 1).padStart(32, '0')}`,
    unitIndex:0,
    name:'Frame + 3 Photos',
    unitAmount:5200,
    quantity:1,
    size:'',
    frameColour:'Natural Oak',
    photoSetCount:1,
    photoCount:3,
    uploadReference:`tf_${String(index + 1).padStart(32, '0')}`,
    artworkObjectKeys:[]
  }));
  const payload = createStripePayload(items, 'https://goodframe.com.au', 'live', 'co_0123456789abcdef0123456789abcdef');
  const metadata = Object.fromEntries([...payload.entries()]
    .filter(([key]) => key.startsWith('metadata['))
    .map(([key, value]) => [key.slice('metadata['.length, -1), value]));
  const bucket = new MemoryR2Bucket();
  for (const item of items) {
    const photoId = `ph_${item.productCode.padStart(32, '0')}`;
    const revision = '11111111-2222-4333-8444-555555555555';
    const uploadSessionId = item.uploadReference;
    const objectKey = `tinyframes/${uploadSessionId}/photos/${photoId}.jpg`;
    await bucket.put(objectKey, fakeJpeg(), {
      httpMetadata:{ contentType:'image/jpeg' },
      customMetadata:{
        upload_session_id:uploadSessionId,
        photo_id:photoId,
        revision,
        position:'1'
      }
    });
    await bucket.put(`tinyframes/${uploadSessionId}/manifest.json`, JSON.stringify({
      storage_version:2,
      upload_session_id:uploadSessionId,
      product_codes:[item.productCode],
      photos:[{ photo_id:photoId, objectKey, position:1, revision }],
      status:'finalized'
    }), { httpMetadata:{ contentType:'application/json' } });
  }

  await markUploadSessionsPaid({
    id:'cs_live_many_products',
    metadata
  }, { ARTWORK_BUCKET:bucket });

  for (const item of items) {
    const finalManifest = await bucket.get(
      [...bucket.objects.keys()].find(key => new RegExp(`^orders/\\d{4}-\\d{2}-\\d{2}_${item.productCode}/manifest\\.json$`).test(key))
    );
    assert.ok(finalManifest, `missing paid files for product ${item.productCode}`);
  }
  const uploadMetadataValues = Object.entries(metadata)
    .filter(([key]) => /^upload_session_ids(?:_[1-9][0-9]*)?$/.test(key))
    .map(([, value]) => value);
  assert.ok(uploadMetadataValues.length > 1);
  assert.ok(uploadMetadataValues.every(value => value.length <= 500));
});

test('paid order photo collisions fail closed without replacing existing files', async () => {
  const bucket = new MemoryR2Bucket();
  const uploadSessionId = 'tf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab';
  const photoId = `ph_${'a'.repeat(32)}`;
  const productCode = '58321';
  const stripeCheckoutSessionId = 'cs_live_existing_order';
  const sourceKey = `tinyframes/${uploadSessionId}/photos/${photoId}.jpg`;
  const finalKey = `orders/2026-10-27_${productCode}/photo-01.jpg`;
  const photoMetadata = {
    upload_session_id:uploadSessionId,
    photo_id:photoId,
    revision:'11111111-2222-4333-8444-555555555555',
    position:'1'
  };
  await bucket.put(sourceKey, fakeJpeg(), {
    httpMetadata:{ contentType:'image/jpeg' },
    customMetadata:photoMetadata
  });
  await bucket.put(`tinyframes/${uploadSessionId}/manifest.json`, JSON.stringify({
    storage_version:2,
    upload_session_id:uploadSessionId,
    product_codes:[productCode],
    photos:[{ photo_id:photoId, objectKey:sourceKey, position:1, revision:photoMetadata.revision }],
    status:'finalized',
    paid_at:'2026-10-27T00:00:00.000Z'
  }), { httpMetadata:{ contentType:'application/json' } });
  const existingBytes = new Uint8Array([1, 2, 3]);
  await bucket.put(finalKey, existingBytes, {
    customMetadata:{
      ...photoMetadata,
      order_code:productCode,
      product_codes:productCode,
      stripe_checkout_session_id:'cs_live_another_order',
      status:'paid'
    }
  });

  await assert.rejects(
    markUploadSessionsPaid({
      id:stripeCheckoutSessionId,
      metadata:{ upload_session_ids:uploadSessionId }
    }, { ARTWORK_BUCKET:bucket }),
    /Refusing to replace a different paid-order photo/
  );
  assert.deepEqual(new Uint8Array(bucket.objects.get(finalKey).bytes), existingBytes);
});

test('individual upload never reports success unless R2 confirms the stored object', async () => {
  const bucket = new MemoryR2Bucket();
  const database = createProductCodeDatabase();
  const env = {
    ARTWORK_BUCKET:bucket,
    PRODUCT_CODES_DB:database,
    ALLOWED_ORIGINS:'https://goodframe.com.au',
    IMAGES:{ info:async () => ({ width:1080, height:1720 }) }
  };
  const uploadSessionId = 'tf_dddddddddddddddddddddddddddddddd';
  const uploadToken = `ut_${'e'.repeat(64)}`;
  const cartItemId = `ci_${'f'.repeat(32)}`;
  const sessionResponse = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/session', {
    method:'POST',
    headers:{ Origin:'https://goodframe.com.au', 'Content-Type':'application/json' },
    body:JSON.stringify({ uploadSessionId, uploadToken, cartItemId })
  }), env);
  assert.equal(sessionResponse.status, 200);
  const photoId = `ph_${'f'.repeat(32)}`;
  const revision = '11111111-2222-3333-4444-555555555555';
  const selectionResponse = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/selection', {
    method:'POST',
    headers:{ Origin:'https://goodframe.com.au', 'Content-Type':'application/json', 'X-Upload-Token':uploadToken },
    body:JSON.stringify({
      uploadSessionId,
      cartItemId,
      selectionVersion:0,
      photoSetCount:1,
      frameColour:'Natural Oak',
      selection:[{ photoId, revision }, null, null]
    })
  }), env);
  assert.equal(selectionResponse.status, 200);
  const normalPut = bucket.put.bind(bucket);
  bucket.put = async (key, body, options) => key.endsWith('.jpg') ? { key } : normalPut(key, body, options);
  const form = new FormData();
  form.append('upload_session_id', uploadSessionId);
  form.append('photo_id', photoId);
  form.append('revision', revision);
  form.append('position', '1');
  form.append('file', new File([fakeJpeg()], 'photo.jpg', { type:'image/jpeg' }));
  const response = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/photo', {
    method:'POST',
    headers:{ Origin:'https://goodframe.com.au', 'X-Upload-Token':uploadToken },
    body:form
  }), env);
  assert.equal(response.status, 500);
  assert.equal((await response.json()).code, 'PHOTO_UPLOAD_FAILED');
  database.close();
});

class MemoryR2Bucket {
  constructor() {
    this.objects = new Map();
    this.nextEtag = 1;
  }
  async head(key) {
    const stored = this.objects.get(key);
    return stored ? {
      key,
      size:stored.bytes.byteLength,
      httpEtag:stored.httpEtag,
      httpMetadata:{ contentType:stored.contentType },
      customMetadata:stored.customMetadata
    } : null;
  }
  async put(key, body, options = {}) {
    if (options.onlyIf?.etagDoesNotMatch === '*' && this.objects.has(key)) return null;
    if (
      options.onlyIf?.etagMatches &&
      this.objects.get(key)?.httpEtag !== options.onlyIf.etagMatches
    ) return null;
    const bytes = await new Response(body).arrayBuffer();
    this.objects.set(key, {
      bytes,
      httpEtag:`"test-etag-${this.nextEtag++}"`,
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

function frameOnly(overrides = {}) {
  return {
    productType: 'tiny_frame_only',
    cartItemId:'ci_11111111111111111111111111111111',
    size: '80x80mm',
    frameColour: 'Natural Oak',
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
    frameColour: 'Legacy finish',
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
    frameColour:'Natural Oak',
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

test('variable photo-set pricing is calculated on the server from $50 including three photos plus $5 per additional set', () => {
  const lineItems = [0, 1, 2, 3, 4, 5].map(photoSetCount => (
    buildLineItems([frameWithPhotoSets(photoSetCount)])[0]
  ));
  assert.deepEqual(lineItems.map(item => item.unitAmount), [5000, 5000, 5500, 6000, 6500, 7000]);
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
  const expectedAmounts = [5000, 5500, 6000, 6500];
  for (const [index, photoSetCount] of [1, 2, 3, 4].entries()) {
    const lineItems = buildLineItems([frameWithPhotoSets(photoSetCount)]).map(item => ({ ...item, productCode:'73194' }));
    const payload = createStripePayload(lineItems, 'https://goodframe.com.au', 'live', `co_${String(index + 1).repeat(32)}`);
    assert.equal(payload.get('line_items[0][price_data][unit_amount]'), String(expectedAmounts[index]));
    assert.equal(payload.get('line_items[0][price_data][product_data][name]'), `Frame + ${photoSetCount * 3} Photos`);
    assert.equal(payload.get('line_items[0][price_data][product_data][metadata][photo_set_count]'), String(photoSetCount));
    assert.equal(payload.get('line_items[0][price_data][product_data][metadata][photo_count]'), String(photoSetCount * 3));
  }
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
  assert.equal(payload.get('line_items[0][price_data][product_data][metadata][frame_colour]'), 'Natural Oak');
  assert.equal(payload.get('line_items[0][price_data][product_data][metadata][upload_reference]'), uploadReference);
  assert.equal(payload.get('line_items[0][price_data][product_data][metadata][upload_session_id]'), uploadReference);
  assert.equal(payload.get('line_items[0][price_data][product_data][metadata][product_code]'), '19472');
  assert.equal(payload.get('metadata[product_codes]'), '19472');
  assert.equal(payload.get('payment_intent_data[metadata][product_codes]'), '19472');
  const productMap = `1:19472 | Natural Oak | Frame + Eight Photos | AUD 64.95 | 8 photos | Upload ${uploadReference}`;
  assert.equal(payload.get('metadata[product_map]'), productMap);
  assert.equal(payload.get('payment_intent_data[metadata][product_map]'), productMap);
  assert.equal(payload.get('payment_intent_data[metadata][frame_colours]'), 'Natural Oak');
  assert.equal(payload.get('payment_intent_data[description]'), 'Good Frame Order');
  assert.equal(payload.get('metadata[upload_references]'), uploadReference);
  assert.equal(payload.get('metadata[upload_session_ids]'), uploadReference);
  assert.equal(payload.get('success_url'), 'https://goodframe.com.au/?checkout=success&session_id={CHECKOUT_SESSION_ID}');
  assert.equal(payload.get('cancel_url'), 'https://goodframe.com.au/?checkout=cancelled#cart');
  assert.equal([...payload.keys()].some(key => key.includes('artwork_object_keys')), false);
});

test('Stripe metadata links the upload session and five-digit order code without PDF references', () => {
  const productCode = '58321';
  const lineItems = buildLineItems([frameWithPictures()])
    .map(item => item.cartItemId ? { ...item, productCode } : item);
  const payload = createStripePayload(
    lineItems,
    'https://goodframe.com.au',
    'live',
    'co_0123456789abcdef0123456789abcdef'
  );
  assert.equal(payload.get('metadata[product_codes]'), productCode);
  assert.equal(payload.get('metadata[upload_references]'), uploadReference);
  assert.equal(payload.get('line_items[0][price_data][product_data][metadata][product_code]'), productCode);
  assert.equal(payload.get('line_items[0][price_data][product_data][metadata][upload_reference]'), uploadReference);
  assert.match(payload.get('payment_intent_data[metadata][product_map]'), /8 photos \| Upload tf_[a-f0-9]{32}/);
  assert.doesNotMatch([...payload.values()].join('\n'), /\.pdf|print-sheet/i);
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

test('seven-day cleanup removes abandoned drafts but retains active checkouts and paid-order photos', async () => {
  const bucket = new MemoryR2Bucket();
  const database = createProductCodeDatabase();
  const now = Date.parse('2026-10-06T00:00:00.000Z');
  const staleUpdatedAt = new Date(now - (8 * 24 * 60 * 60 * 1000)).toISOString();
  const sessions = [
    { id:`tf_${'1'.repeat(32)}`, cart:`ci_${'1'.repeat(32)}`, status:'draft' },
    { id:`tf_${'2'.repeat(32)}`, cart:`ci_${'2'.repeat(32)}`, status:'checkout_pending' },
    { id:`tf_${'3'.repeat(32)}`, cart:`ci_${'3'.repeat(32)}`, status:'paid' }
  ];
  const storageFolders = [];
  for (const [index, session] of sessions.entries()) {
    const token = `ut_${String(index + 1).repeat(64)}`;
    const response = await worker.fetch(new Request('https://worker.example/tiny-frame-upload/session', {
      method:'POST',
      headers:{ Origin:'https://goodframe.com.au', 'Content-Type':'application/json' },
      body:JSON.stringify({
        uploadSessionId:session.id,
        uploadToken:token,
        cartItemId:session.cart
      })
    }), {
      ARTWORK_BUCKET:bucket,
      PRODUCT_CODES_DB:database,
      ALLOWED_ORIGINS:'https://goodframe.com.au'
    });
    assert.equal(response.status, 200);
    const upload = await response.json();
    storageFolders.push(upload.storageFolder);
    await bucket.put(`uploads/${upload.productCode}/photo-01.jpg`, 'photo', {
      customMetadata:{ upload_session_id:session.id, product_code:upload.productCode }
    });
    database.prepare(
      `UPDATE photo_upload_sessions
          SET status = ?,
              stripe_checkout_session_id = ?,
              checkout_expires_at = ?,
              updated_at = ?
        WHERE upload_session_id = ?`
    ).bind(
      session.status,
      session.status === 'draft' ? null : `cs_test_cleanup${index}`,
      session.status === 'checkout_pending' ? new Date(now + 3600000).toISOString() : null,
      staleUpdatedAt,
      session.id
    ).run();
  }
  const deleted = await cleanupPendingUploads({
    ARTWORK_BUCKET:bucket,
    PRODUCT_CODES_DB:database,
    PENDING_UPLOAD_TTL_DAYS:'7'
  }, now);
  assert.equal(deleted, 1);
  assert.equal(bucket.objects.has(`uploads/${storageFolders[0]}/manifest.json`), false);
  assert.equal(bucket.objects.has(`uploads/${storageFolders[0]}/photo-01.jpg`), false);
  assert.equal(bucket.objects.has(`uploads/${storageFolders[1]}/manifest.json`), true);
  assert.equal(bucket.objects.has(`uploads/${storageFolders[2]}/manifest.json`), true);
  database.close();
});
