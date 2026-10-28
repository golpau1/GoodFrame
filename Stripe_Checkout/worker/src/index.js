import {
  createOriginalObjectKey,
  createProductPhotoFolder,
  createThumbnailObjectKey,
  getBrisbaneDateParts,
  isValidArtworkObjectKey,
  sanitizeUploadId
} from './r2-keys.js';
import {
  ProductCodeCapacityError,
  ProductCodeError,
  beginCheckoutRequest,
  completeCheckoutRequest,
  findCheckoutAttachment,
  findProductCode,
  getProductCodeCapacity,
  markProductCodesPaid,
  moveReservedProductsToCheckoutRequest,
  normalizeCartItemId,
  normalizeCheckoutRequestId,
  normalizeProductCode,
  reserveCartProductCode,
  reserveProductCodes
} from './product-codes.js';

const PRICE_BY_SIZE = Object.freeze({
  '80x80mm': 7000,
  '210x297mm': 9900,
  '420x594mm': 23500,
  '594x841mm': 35000,
  '841x1189mm': 70000
});
const TINY_FRAME_PRODUCTS = Object.freeze({
  tiny_frame_photo_sets: Object.freeze({
    orderType: 'photo-sets',
    name: 'Frame',
    baseUnitAmount: 5000,
    additionalPhotoSetUnitAmount: 500,
    requiresPictures: false
  }),
  tiny_frame_8_pictures: Object.freeze({
    orderType: 'frame-plus-pictures',
    name: 'Frame + Eight Photos',
    unitAmount: 6495,
    requiresPictures: true
  })
});
const SHIPPING_AMOUNT = 1000;
const LIVE_INTERNATIONAL_SHIPPING_RATE_ID = 'shr_1UQbhPBqoMGy9EwIyslTEhqQ';
const STRIPE_SHIPPING_COUNTRIES = Object.freeze(['AU', 'NZ', 'US', 'CA', 'GB', 'JP', 'SG', 'DE', 'FR', 'NL']);
const STRIPE_SHIPPING_COUNTRY_SET = new Set(STRIPE_SHIPPING_COUNTRIES);
const TINY_FRAME_UPLOAD_PREFIX = 'temporary/';
const LEGACY_TINY_FRAME_UPLOAD_PREFIX = 'tinyframes/';
const TINY_FRAME_UPLOAD_IMAGE_COUNT = 8;
const TINY_FRAME_PHOTOS_PER_SET = 3;
const TINY_FRAME_PHOTOS_PER_PAGE = 9;
const MAX_TINY_FRAME_ORIGINAL_BYTES = 20 * 1024 * 1024;
const LEGACY_INDIVIDUAL_PHOTO_STORAGE_VERSION = 2;
const INDIVIDUAL_PHOTO_STORAGE_VERSION = 3;
const MAX_TINY_FRAME_UPLOAD_BYTES = 96 * 1024 * 1024;
const CORS_ALLOWED_METHODS = Object.freeze(['GET', 'POST', 'DELETE', 'OPTIONS']);
const CORS_ALLOWED_HEADERS = Object.freeze(['content-type', 'authorization', 'x-upload-token', 'x-upload-attempt']);
const TINY_FRAME_PHOTO_WIDTH_INCHES = 54 / 25.4;
const TINY_FRAME_PHOTO_HEIGHT_INCHES = 86 / 25.4;
const TINY_FRAME_LOW_RESOLUTION_PPI = 200;
const SUPPORTED_TINY_FRAME_IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/gif']);
const DEFAULT_PENDING_UPLOAD_TTL_DAYS = 7;

class TinyFrameInputError extends Error {}
function normalizePhotoSetCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 && Number.isSafeInteger(count * TINY_FRAME_PHOTOS_PER_SET) ? count : null;
}

function getTinyFramePhotoCount(productType, photoSetCount) {
  return productType === 'tiny_frame_8_pictures'
    ? TINY_FRAME_UPLOAD_IMAGE_COUNT
    : photoSetCount * TINY_FRAME_PHOTOS_PER_SET;
}

function getTinyFrameUnitAmount(productType, photoSetCount = 0) {
  if (productType === 'tiny_frame_8_pictures') return TINY_FRAME_PRODUCTS.tiny_frame_8_pictures.unitAmount;
  if (productType !== 'tiny_frame_photo_sets' || normalizePhotoSetCount(photoSetCount) === null) return undefined;
  const product = TINY_FRAME_PRODUCTS.tiny_frame_photo_sets;
  const additionalPhotoSetCount = Math.max(0, photoSetCount - 1);
  const amount = product.baseUnitAmount + (additionalPhotoSetCount * product.additionalPhotoSetUnitAmount);
  return Number.isSafeInteger(amount) ? amount : undefined;
}

function tinyFrameNameFor(productType, photoCount) {
  if (productType === 'tiny_frame_8_pictures') return TINY_FRAME_PRODUCTS.tiny_frame_8_pictures.name;
  return photoCount ? `Frame + ${photoCount} Photos` : 'Frame Only';
}

const CANONICAL_SIZE_BY_DIMENSIONS = Object.freeze({
  '80x80': '80x80mm',
  '210x297': '210x297mm',
  '200x300': '210x297mm',
  '420x594': '420x594mm',
  '400x600': '420x594mm',
  '594x841': '594x841mm',
  '600x900': '594x841mm',
  '841x1189': '841x1189mm',
  '800x1200': '841x1189mm',
  '900x1200': '841x1189mm'
});

function getStripeMode(env) {
  const stripeMode = String(env.STRIPE_MODE || '').trim().toLowerCase();
  return ['live', 'test'].includes(stripeMode) ? stripeMode : '';
}

function getStripeConfiguration(env) {
  const mode = getStripeMode(env);
  if (!mode) return null;

  // The legacy secret names remain live-only fallbacks so the currently
  // deployed production Worker keeps working while its secrets are migrated.
  // Test mode never reads a generic or live credential.
  const secretKey = String(mode === 'live'
    ? env.STRIPE_LIVE_SECRET_KEY || env.STRIPE_SECRET_KEY || ''
    : env.STRIPE_TEST_SECRET_KEY || '');
  const publishableKey = String(mode === 'live'
    ? env.STRIPE_LIVE_PUBLISHABLE_KEY || ''
    : env.STRIPE_TEST_PUBLISHABLE_KEY || '');
  const webhookSecret = String(mode === 'live'
    ? env.STRIPE_LIVE_WEBHOOK_SECRET || env.STRIPE_WEBHOOK_SECRET || ''
    : env.STRIPE_TEST_WEBHOOK_SECRET || '');
  const requiredSecretPrefix = mode === 'live' ? 'sk_live_' : 'sk_test_';
  const requiredPublishablePrefix = mode === 'live' ? 'pk_live_' : 'pk_test_';

  if (!secretKey.startsWith(requiredSecretPrefix)) return null;
  if (publishableKey && !publishableKey.startsWith(requiredPublishablePrefix)) return null;
  if (webhookSecret && !webhookSecret.startsWith('whsec_')) return null;

  return Object.freeze({
    mode,
    secretKey,
    publishableKey,
    webhookSecret,
    fulfilmentEnabled:mode === 'live'
  });
}

function getInternationalShippingRateId(env, stripeMode) {
  if (stripeMode === 'live') return LIVE_INTERNATIONAL_SHIPPING_RATE_ID;
  const testRateId = String(env.STRIPE_TEST_INTERNATIONAL_SHIPPING_RATE_ID || '').trim();
  return testRateId.startsWith('shr_') ? testRateId : '';
}

function normalizeShippingCountry(value, fallback = '') {
  const country = String(value || fallback).trim().toUpperCase();
  return STRIPE_SHIPPING_COUNTRY_SET.has(country) ? country : '';
}

function getSiteBaseUrl(env) {
  const siteBaseUrl = String(env.SITE_BASE_URL || '').replace(/\/$/, '');
  const stripeMode = String(env.STRIPE_MODE || '').trim().toLowerCase();

  if (!siteBaseUrl || (stripeMode === 'live' && siteBaseUrl !== 'https://goodframe.com.au')) {
    return '';
  }

  return siteBaseUrl;
}

function getAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  const allowedOrigins = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  return origin && allowedOrigins.includes(origin) ? origin : '';
}

function createCorsHeaders(request, env) {
  const headers = new Headers({
    'Access-Control-Allow-Methods': CORS_ALLOWED_METHODS.join(','),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Upload-Token, X-Upload-Attempt',
    'Cache-Control': 'no-store, max-age=0',
    'Content-Type': 'application/json',
    'Pragma': 'no-cache'
  });
  const allowedOrigin = getAllowedOrigin(request, env);

  headers.set('Vary', 'Origin');
  if (allowedOrigin) {
    headers.set('Access-Control-Allow-Origin', allowedOrigin);
  }

  return headers;
}

function jsonResponse(request, env, payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: createCorsHeaders(request, env)
  });
}

function getWorkerBaseUrl(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function getArtworkUrl(request, objectKey) {
  return `${getWorkerBaseUrl(request)}/artwork/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
}

function normalizeUploadStorageFolder(value) {
  const folder = String(value || '').trim();
  return /^(?:[1-9]\d{4}|\d{4}-\d{2}-\d{2} - (?:0[1-9]|1[0-2])\.\d{2} (?:AM|PM) - [1-9]\d{4}|\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[a-f0-9]{4}|\d{2}-\d{2}-\d{4}_(?:[1-9]|1[0-2])-\d{2}(?:AM|PM)(?:-[a-f0-9]{4})?)$/.test(folder)
    ? folder
    : '';
}

function getProductCodeFromUploadFolder(value) {
  const folder = normalizeUploadStorageFolder(value);
  if (!folder) return '';
  if (/^[1-9]\d{4}$/.test(folder)) return folder;
  return normalizeProductCode(folder.match(/ - ([1-9]\d{4})$/)?.[1]);
}

function getProductUploadFolder(value, expectedProductCode = '') {
  const folder = normalizeUploadStorageFolder(value);
  const code = normalizeProductCode(expectedProductCode);
  const folderCode = getProductCodeFromUploadFolder(folder);
  return folderCode && (!code || folderCode === code) ? folder : '';
}

function getPhotoUploadStorageFolder(record, uploadSessionId = record?.upload_session_id) {
  return normalizeUploadStorageFolder(record?.storage_folder) ||
    normalizeProductCode(record?.product_code) ||
    normalizeUploadReference(uploadSessionId);
}

function getTinyFrameUploadPrefix(uploadSessionId, storageFolder = '') {
  const folder = normalizeUploadStorageFolder(storageFolder) || normalizeUploadReference(uploadSessionId);
  return folder
    ? `${getProductCodeFromUploadFolder(folder) ? 'uploads/' : TINY_FRAME_UPLOAD_PREFIX}${folder}/`
    : '';
}

function getUploadManifestKey(uploadSessionId, storageFolder = '') {
  const prefix = getTinyFrameUploadPrefix(uploadSessionId, storageFolder);
  return prefix ? `${prefix}manifest.json` : '';
}

function getLegacyIndividualUploadManifestKey(uploadSessionId) {
  return `${LEGACY_TINY_FRAME_UPLOAD_PREFIX}${uploadSessionId}/manifest.json`;
}

function normalizeUploadToken(value) {
  const token = String(value || '').trim().toLowerCase();
  return /^ut_[a-f0-9]{64}$/.test(token) ? token : '';
}

function normalizePhotoId(value) {
  const id = String(value || '').trim().toLowerCase();
  return /^ph_[a-f0-9]{32}$/.test(id) ? id : '';
}

function getIndividualPhotoKey(uploadSessionId, photoId) {
  const sessionId = normalizeUploadReference(uploadSessionId);
  const normalizedPhotoId = normalizePhotoId(photoId);
  return sessionId && normalizedPhotoId
    ? `${LEGACY_TINY_FRAME_UPLOAD_PREFIX}${sessionId}/photos/${normalizedPhotoId}.jpg`
    : '';
}

function getProductPhotoKey(productCode, position, storageFolder = '') {
  const code = normalizeProductCode(productCode);
  const folder = getProductUploadFolder(storageFolder, code) || code;
  return code && Number.isSafeInteger(position) && position > 0
    ? `uploads/${folder}/photo-${String(position).padStart(2, '0')}.jpg`
    : '';
}

function getTemporaryPhotoKey(uploadSessionId, storageFolder = '', photoId = '', revision = '') {
  const sessionId = normalizeUploadReference(uploadSessionId);
  const normalizedPhotoId = normalizePhotoId(photoId);
  const normalizedRevision = String(revision || '').trim().toLowerCase().replaceAll('-', '');
  return sessionId && normalizedPhotoId && /^[a-f0-9]{32}$/.test(normalizedRevision)
    ? `${getTinyFrameUploadPrefix(sessionId, storageFolder)}photos/${normalizedPhotoId.slice(3)}-${normalizedRevision}.jpg`
    : '';
}

function isValidIndividualPhotoKey(value, uploadSessionId = '', storageFolder = '') {
  const key = String(value || '');
  const productPhoto = key.match(/^uploads\/([^/]+)\/photo-\d{2,}\.(?:jpe?g|png|gif|webp)$/);
  if (productPhoto) {
    const actualFolder = getProductUploadFolder(productPhoto[1]);
    const expectedFolder = normalizeUploadStorageFolder(storageFolder);
    const expectedCode = normalizeProductCode(storageFolder) || getProductCodeFromUploadFolder(expectedFolder);
    return Boolean(
      actualFolder && expectedCode &&
      getProductCodeFromUploadFolder(actualFolder) === expectedCode &&
      (!expectedFolder || /^[1-9]\d{4}$/.test(expectedFolder) || actualFolder === expectedFolder)
    );
  }
  // The single-ID form is retained for sessions created by the immediately
  // preceding release. New writes include both photo and revision identities,
  // making a retry resolve to the same immutable R2 key.
  const temporary = key.match(/^temporary\/([^/]+)\/photos\/[a-f0-9]{32}(?:-[a-f0-9]{32})?\.jpg$/);
  if (temporary) {
    const expectedFolder = normalizeUploadStorageFolder(storageFolder) || normalizeUploadReference(uploadSessionId);
    const validFolder = normalizeUploadStorageFolder(temporary[1]) || normalizeUploadReference(temporary[1]);
    return Boolean(validFolder && (!expectedFolder || temporary[1] === expectedFolder));
  }
  const legacy = key.match(/^tinyframes\/(tf_[a-f0-9]{32})\/photos\/ph_[a-f0-9]{32}\.jpg$/);
  return Boolean(legacy && (!uploadSessionId || legacy[1] === uploadSessionId));
}

function parsePhotoUploadJson(value, fallback) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function getPhotoUploadSession(database, uploadSessionId) {
  if (!database) return null;
  return database.prepare(
    'SELECT * FROM photo_upload_sessions WHERE upload_session_id = ?'
  ).bind(uploadSessionId).first();
}

function photoUploadSelection(record) {
  const selection = parsePhotoUploadJson(record?.selection_json, []);
  return Array.isArray(selection) ? selection : [];
}

async function savePhotoUploadSelection(database, record, selection, updatedAt, {
  photoSetCount = Number(record.photo_set_count || 0),
  frameColour = record.frame_colour || null,
  selectionChanged = false
} = {}) {
  const result = await database.prepare(
    `UPDATE photo_upload_sessions
        SET selection_json = ?,
            selection_version = selection_version + ?,
            state_version = state_version + 1,
            photo_set_count = ?,
            frame_colour = ?,
            updated_at = ?
      WHERE upload_session_id = ?
        AND state_version = ?
        AND status = 'draft'`
  ).bind(
    JSON.stringify(selection),
    selectionChanged ? 1 : 0,
    photoSetCount,
    frameColour,
    updatedAt,
    record.upload_session_id,
    Number(record.state_version)
  ).run();
  return Number(result?.meta?.changes ?? result?.changes ?? 0) === 1;
}

function getLegacyUploadManifestKey(uploadReference) {
  return `tiny-frame-uploads/${uploadReference}.json`;
}

function getProductPdfKey(productCode) {
  const code = normalizeProductCode(productCode);
  return code ? `${code}/${code}-print-sheet.pdf` : '';
}

function getProductPdfKeyCandidates(productCode) {
  const code = normalizeProductCode(productCode);
  return code ? [
    getProductPdfKey(code),
    `tinyframes/products/${code}/print-sheet-${code}.pdf`
  ] : [];
}

async function deleteObjectKeys(bucket, keys) {
  await Promise.allSettled(keys.map(key => bucket.delete(key)));
}

function calculateEffectivePpi(width, height) {
  return Math.min(width / TINY_FRAME_PHOTO_WIDTH_INCHES, height / TINY_FRAME_PHOTO_HEIGHT_INCHES);
}

async function requireIndividualUploadSession(request, env, uploadSessionId) {
  const sessionId = normalizeUploadReference(uploadSessionId);
  const token = normalizeUploadToken(request.headers.get('X-Upload-Token'));
  if (!sessionId || !token) {
    const error = new TinyFrameInputError('Upload session credentials are invalid');
    error.code = 'UPLOAD_SESSION_INVALID';
    throw error;
  }
  const sessionRecord = await getPhotoUploadSession(env.PRODUCT_CODES_DB, sessionId);
  const storageFolder = getPhotoUploadStorageFolder(sessionRecord, sessionId);
  const manifestKey = sessionRecord
    ? getUploadManifestKey(sessionId, storageFolder)
    : getLegacyIndividualUploadManifestKey(sessionId);
  let object = await env.ARTWORK_BUCKET.get(manifestKey);
  if (!object && !sessionRecord) object = await env.ARTWORK_BUCKET.get(getLegacyUploadManifestKey(sessionId));
  const manifest = await readR2Json(object);
  const expectedTokenHash = sessionRecord
    ? String(sessionRecord.upload_token_hash || '')
    : String(manifest?.upload_token_hash || '');
  if (
    !manifest || ![LEGACY_INDIVIDUAL_PHOTO_STORAGE_VERSION, INDIVIDUAL_PHOTO_STORAGE_VERSION].includes(Number(manifest.storage_version)) ||
    manifest.upload_session_id !== sessionId ||
    expectedTokenHash !== await sha256Hex(token)
  ) {
    const error = new TinyFrameInputError('Upload session could not be authenticated');
    error.code = 'UPLOAD_SESSION_AUTH_FAILED';
    throw error;
  }
  if (sessionRecord?.status === 'expired') {
    const error = new TinyFrameInputError('Upload session has expired');
    error.code = 'UPLOAD_SESSION_EXPIRED';
    throw error;
  }
  if (sessionRecord?.status === 'paid' || manifest.status === 'paid') {
    throw new TinyFrameInputError('Paid order photos cannot be changed');
  }
  return { manifestKey, manifest, sessionRecord, storageFolder };
}

async function enforceIndividualUploadRateLimit(env, uploadSessionId) {
  if (!env.UPLOAD_RATE_LIMITER?.limit) return;
  const result = await env.UPLOAD_RATE_LIMITER.limit({ key:uploadSessionId });
  if (!result?.success) {
    const error = new TinyFrameInputError('Too many upload requests. Please wait a moment and retry.');
    error.status = 429;
    throw error;
  }
}

async function createIndividualUploadSession(request, env) {
  if (!env.ARTWORK_BUCKET || !env.PRODUCT_CODES_DB) return jsonResponse(request, env, { error:'Photo storage is not configured' }, 503);
  if (!getAllowedOrigin(request, env)) return jsonResponse(request, env, { error:'Origin is not allowed' }, 403);
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse(request, env, { error:'Request body must be valid JSON' }, 400); }
  const uploadSessionId = normalizeUploadReference(body?.uploadSessionId);
  const uploadToken = normalizeUploadToken(body?.uploadToken);
  const cartItemId = normalizeCartItemId(body?.cartItemId);
  if (!uploadSessionId || !uploadToken || !cartItemId) {
    return jsonResponse(request, env, { error:'Upload session credentials are invalid' }, 400);
  }
  try {
    await enforceIndividualUploadRateLimit(env, `create:${request.headers.get('CF-Connecting-IP') || 'unknown'}`);
  } catch (error) {
    return jsonResponse(request, env, { error:error.message }, Number(error?.status) || 429);
  }
  const tokenHash = await sha256Hex(uploadToken);
  const createdAt = new Date().toISOString();
  let sessionRecord = await getPhotoUploadSession(env.PRODUCT_CODES_DB, uploadSessionId);
  if (!sessionRecord) {
    const allocation = await reserveProductCodes(env.PRODUCT_CODES_DB, [{
      cartItemId,
      unitIndex:0,
      productType:'tiny_frame_photo_sets',
      uploadReference:uploadSessionId
    }], `co_${cartItemId.slice(3)}`);
    const productCode = normalizeProductCode(allocation.units[0]?.productCode);
    if (!productCode) throw new Error('A unique five-digit product code could not be allocated');
    const storageFolder = createProductPhotoFolder(productCode, new Date(createdAt));
    await env.PRODUCT_CODES_DB.prepare(
      `INSERT OR IGNORE INTO photo_upload_sessions
        (upload_session_id, cart_item_id, upload_token_hash, status, selection_json,
         selection_version, state_version, photo_set_count, product_codes_json,
         storage_folder, product_code, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', '[]', 0, 0, 1, ?, ?, ?, ?, ?)`
    ).bind(uploadSessionId, cartItemId, tokenHash, JSON.stringify([productCode]), storageFolder, productCode, createdAt, createdAt).run();
    sessionRecord = await getPhotoUploadSession(env.PRODUCT_CODES_DB, uploadSessionId);
  }
  if (
    !sessionRecord || sessionRecord.cart_item_id !== cartItemId ||
    sessionRecord.upload_token_hash !== tokenHash
  ) return jsonResponse(request, env, { error:'This upload session is already in use', code:'UPLOAD_SESSION_CONFLICT' }, 409);
  const storageFolder = getPhotoUploadStorageFolder(sessionRecord, uploadSessionId);
  const productCode = normalizeProductCode(sessionRecord.product_code);
  const manifestKey = getUploadManifestKey(uploadSessionId, storageFolder);
  const existing = await env.ARTWORK_BUCKET.get(manifestKey);
  if (existing) {
    const manifest = await readR2Json(existing);
    if (manifest?.upload_session_id !== uploadSessionId || ![LEGACY_INDIVIDUAL_PHOTO_STORAGE_VERSION, INDIVIDUAL_PHOTO_STORAGE_VERSION].includes(Number(manifest.storage_version))) {
      return jsonResponse(request, env, { error:'This upload session is already in use', code:'UPLOAD_SESSION_CONFLICT' }, 409);
    }
    return jsonResponse(request, env, {
      success:true,
      uploadSessionId,
      productCode,
      storageFolder,
      selectionVersion:Number(sessionRecord.selection_version),
      recovered:true
    });
  }
  const stored = await env.ARTWORK_BUCKET.put(manifestKey, JSON.stringify({
    storage_version:INDIVIDUAL_PHOTO_STORAGE_VERSION,
    upload_session_id:uploadSessionId,
    storage_folder:storageFolder,
    product_code:productCode || null,
    cart_item_id:cartItemId,
    upload_token_hash:tokenHash,
    product_type:'tiny_frame_photo_sets',
    photos:[],
    files:[],
    status:'draft',
    created_at:createdAt,
    updated_at:createdAt,
    uploaded_at:createdAt,
    expires_at:new Date(Date.parse(createdAt) + 7 * 24 * 60 * 60 * 1000).toISOString()
  }), {
    httpMetadata:{ contentType:'application/json' },
    onlyIf:{ etagDoesNotMatch:'*' }
  });
  if (stored === null) return jsonResponse(request, env, { error:'Upload session could not be created' }, 409);
  return jsonResponse(request, env, {
    success:true,
    uploadSessionId,
    productCode,
    storageFolder,
    selectionVersion:Number(sessionRecord.selection_version)
  });
}

async function updateIndividualPhotoSelection(request, env) {
  if (!env.ARTWORK_BUCKET || !env.PRODUCT_CODES_DB) {
    return jsonResponse(request, env, { error:'Photo storage is not configured' }, 503);
  }
  if (!getAllowedOrigin(request, env)) return jsonResponse(request, env, { error:'Origin is not allowed' }, 403);
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse(request, env, { error:'Request body must be valid JSON' }, 400); }
  const uploadSessionId = normalizeUploadReference(body?.uploadSessionId);
  const cartItemId = normalizeCartItemId(body?.cartItemId);
  const frameColour = normalizeFrameColour(body?.frameColour);
  const photoSetCount = normalizePhotoSetCount(body?.photoSetCount);
  const expectedVersion = Number(body?.selectionVersion);
  const requestedSelection = Array.isArray(body?.selection) ? body.selection : null;
  if (
    !uploadSessionId || !cartItemId || photoSetCount === null ||
    !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 ||
    !requestedSelection || requestedSelection.length !== photoSetCount * TINY_FRAME_PHOTOS_PER_SET
  ) return jsonResponse(request, env, { error:'Photo selection details are invalid' }, 400);
  try {
    const { sessionRecord, storageFolder } = await requireIndividualUploadSession(request, env, uploadSessionId);
    if (!sessionRecord || sessionRecord.cart_item_id !== cartItemId) {
      throw new TinyFrameInputError('Photo selection does not match this product');
    }
    const requested = requestedSelection.map((photo, index) => {
      if (photo === null) return { position:index + 1, photo_id:null, revision:'', object_key:'', status:'empty' };
      const photoId = normalizePhotoId(photo?.photoId);
      const revision = String(photo?.revision || '').trim().toLowerCase();
      if (!photoId || !/^[a-f0-9-]{32,36}$/.test(revision)) {
        throw new TinyFrameInputError('Photo selection identity is invalid');
      }
      return { position:index + 1, photo_id:photoId, revision, object_key:'', status:'uploading' };
    });
    const requestedIds = requested.filter(photo => photo.photo_id).map(photo => photo.photo_id);
    if (new Set(requestedIds).size !== requestedIds.length) {
      throw new TinyFrameInputError('A photo cannot be selected in more than one position');
    }
    let record = sessionRecord;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (record.status !== 'draft') throw new TinyFrameInputError('This photo selection is locked for checkout');
      if (Number(record.selection_version) !== expectedVersion) {
        return jsonResponse(request, env, {
          error:'Photo selection changed. Please retry the selection update.',
          code:'SELECTION_VERSION_CONFLICT',
          selectionVersion:Number(record.selection_version)
        }, 409);
      }
      const previousSelection = photoUploadSelection(record);
      const previousByIdentity = new Map(previousSelection
        .filter(photo => photo?.photo_id && photo?.revision)
        .map(photo => [`${photo.photo_id}:${photo.revision}`, photo]));
      const nextSelection = requested.map(photo => {
        if (!photo.photo_id) return photo;
        const previous = previousByIdentity.get(`${photo.photo_id}:${photo.revision}`);
        return previous?.object_key && isValidIndividualPhotoKey(previous.object_key, uploadSessionId, storageFolder)
          ? { ...photo, object_key:previous.object_key, status:previous.status }
          : photo;
      });
      if (normalizeProductCode(record.product_code)) {
        await normalizeProductPhotoSelection(
          env.ARTWORK_BUCKET,
          uploadSessionId,
          record.product_code,
          storageFolder,
          nextSelection
        );
      }
      const updated = await savePhotoUploadSelection(env.PRODUCT_CODES_DB, record, nextSelection, new Date().toISOString(), {
        photoSetCount,
        frameColour,
        selectionChanged:true
      });
      if (updated) {
        return jsonResponse(request, env, {
          success:true,
          uploadSessionId,
          selectionVersion:Number(record.selection_version) + 1,
          selection:nextSelection
        });
      }
      record = await getPhotoUploadSession(env.PRODUCT_CODES_DB, uploadSessionId);
      if (!record) throw new TinyFrameInputError('Photo upload session could not be found');
    }
    return jsonResponse(request, env, { error:'Photo selection is busy. Please retry.' }, 409);
  } catch (error) {
    return jsonResponse(request, env, {
      error:error.message || 'Photo selection could not be updated',
      ...(error?.code ? { code:String(error.code) } : {})
    }, error instanceof TinyFrameInputError ? 400 : 500);
  }
}

async function normalizeProductPhotoSelection(bucket, uploadSessionId, productCode, storageFolder, selection) {
  const code = normalizeProductCode(productCode);
  if (!code) return;
  const folder = getProductUploadFolder(storageFolder, code) || code;
  const selectedIdentities = new Set(selection
    .filter(photo => photo?.photo_id && photo?.revision)
    .map(photo => `${photo.photo_id}:${photo.revision}`));
  let cursor;
  do {
    const listing = await bucket.list({
      prefix:`uploads/${folder}/photo-`,
      ...(cursor ? { cursor } : {})
    });
    for (const listed of listing.objects || []) {
      const object = await bucket.head(listed.key);
      const metadata = object?.customMetadata || {};
      if (
        metadata.upload_session_id !== uploadSessionId ||
        metadata.product_code !== code
      ) throw new TinyFrameInputError('The product photo folder is already in use');
      if (!selectedIdentities.has(`${metadata.photo_id}:${metadata.revision}`)) {
        await bucket.delete(listed.key);
      }
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);

  if (selection.some(photo => photo?.photo_id && photo.status !== 'uploaded')) {
    let nextPosition = 1;
    const assignedKeys = new Set();
    for (const photo of selection) {
      if (!photo?.photo_id) continue;
      const reservedPosition = Number(photo.object_key?.match(/photo-(\d+)\.jpg$/)?.[1] || 0);
      if (reservedPosition > 0 && !assignedKeys.has(photo.object_key)) {
        assignedKeys.add(photo.object_key);
        nextPosition = Math.max(nextPosition, reservedPosition + 1);
      } else {
        photo.object_key = getProductPhotoKey(code, nextPosition, folder);
        assignedKeys.add(photo.object_key);
        nextPosition += 1;
        if (photo.status === 'uploaded') photo.status = 'uploading';
      }
    }
    return;
  }

  const retained = [];
  for (const photo of selection) {
    if (!photo?.object_key || photo.status !== 'uploaded') continue;
    const object = await bucket.get(photo.object_key);
    const metadata = object?.customMetadata || {};
    if (
      !object ||
      metadata.upload_session_id !== uploadSessionId ||
      metadata.product_code !== code ||
      metadata.photo_id !== photo.photo_id ||
      metadata.revision !== photo.revision
    ) {
      photo.object_key = '';
      photo.status = 'uploading';
      continue;
    }
    retained.push({ photo, objectKey:photo.object_key });
  }
  retained.sort((left, right) => {
    const leftPosition = Number(left.objectKey.match(/photo-(\d+)\.jpg$/)?.[1] || 0);
    const rightPosition = Number(right.objectKey.match(/photo-(\d+)\.jpg$/)?.[1] || 0);
    return leftPosition - rightPosition;
  });

  for (const [index, entry] of retained.entries()) {
    const targetKey = getProductPhotoKey(code, index + 1, folder);
    if (entry.objectKey !== targetKey) {
      const object = await bucket.get(entry.objectKey);
      const stored = await bucket.put(targetKey, object.body, {
        httpMetadata:{ contentType:'image/jpeg' },
        customMetadata:{
          ...(object.customMetadata || {}),
          position:String(entry.photo.position)
        },
        onlyIf:{ etagDoesNotMatch:'*' }
      });
      if (stored === null) throw new TinyFrameInputError('The product photo order changed while it was being saved');
      await bucket.delete(entry.objectKey);
    }
    entry.photo.object_key = targetKey;
    entry.photo.status = 'uploaded';
  }

  let nextPosition = retained.length + 1;
  for (const photo of selection) {
    if (!photo?.photo_id || photo.status === 'uploaded') continue;
    photo.object_key = getProductPhotoKey(code, nextPosition, folder);
    nextPosition += 1;
  }
}

async function uploadIndividualTinyFramePhoto(request, env) {
  const startedAt = Date.now();
  const attemptNumber = Number(request.headers.get('X-Upload-Attempt'));
  const attempt = Number.isSafeInteger(attemptNumber) && attemptNumber >= 1 && attemptNumber <= 10 ? attemptNumber : 1;
  const browserAgent = request.headers.get('User-Agent') || '';
  const browser = /Instagram/i.test(browserAgent)
    ? 'instagram-in-app'
    : /Android/i.test(browserAgent) && /Chrome/i.test(browserAgent)
      ? 'android-chrome'
      : /iPhone|iPad|iPod/i.test(browserAgent)
        ? /Safari/i.test(browserAgent) ? 'ios-safari' : 'ios-browser'
        : /Chrome/i.test(browserAgent) && !/Edg/i.test(browserAgent)
          ? 'desktop-chrome'
          : 'other';
  const logUploadDiagnostic = (details) => {
    const timestamp = new Intl.DateTimeFormat('sv-SE', {
      timeZone:'Australia/Brisbane',
      year:'numeric',
      month:'2-digit',
      day:'2-digit',
      hour:'2-digit',
      minute:'2-digit',
      second:'2-digit',
      hourCycle:'h23'
    }).format(new Date());
    console.info('Photo upload diagnostic', {
      timestamp,
      sessionId:details.uploadSessionId || 'unregistered',
      photoId:details.photoId || 'unknown',
      browser,
      stage:details.stage || 'request-validation',
      status:details.status,
      code:details.code,
      attempt,
      durationMs:Math.max(0, Date.now() - startedAt),
      result:details.result
    });
  };
  let uploadStage = 'request-validation';
  if (!env.ARTWORK_BUCKET || !env.IMAGES) {
    return jsonResponse(request, env, { error:'Photo storage is not configured' }, 503);
  }
  if (!getAllowedOrigin(request, env)) return jsonResponse(request, env, { error:'Origin is not allowed' }, 403);
  let formData;
  try { formData = await request.formData(); }
  catch { return jsonResponse(request, env, { error:'Upload must use multipart form data' }, 400); }
  const uploadSessionId = normalizeUploadReference(formData.get('upload_session_id'));
  const photoId = normalizePhotoId(formData.get('photo_id'));
  const revision = String(formData.get('revision') || '').trim().toLowerCase();
  const position = Number(formData.get('position'));
  const file = formData.get('file');
  if (
    !uploadSessionId || !photoId || !/^[a-f0-9-]{32,36}$/.test(revision) ||
    !Number.isSafeInteger(position) || position < 1
  ) return jsonResponse(request, env, { error:'Photo upload details are invalid' }, 400);
  if (!file || typeof file.arrayBuffer !== 'function' || file.type !== 'image/jpeg') {
    return jsonResponse(request, env, { error:'Cropped photos must be high-quality JPEG files' }, 400);
  }
  if (!file.size || file.size > MAX_TINY_FRAME_ORIGINAL_BYTES) {
    return jsonResponse(request, env, { error:'Each cropped photo must be 20 MB or smaller' }, 413);
  }
  try {
    uploadStage = 'session-authentication';
    const { sessionRecord, storageFolder } = await requireIndividualUploadSession(request, env, uploadSessionId);
    await enforceIndividualUploadRateLimit(env, `${request.headers.get('CF-Connecting-IP') || 'unknown'}:${uploadSessionId}`);
    if (sessionRecord) {
      const selection = photoUploadSelection(sessionRecord);
      const selected = selection.find(photo => photo?.photo_id === photoId && photo?.revision === revision);
      if (sessionRecord.status !== 'draft' || !selected || Number(selected.position) !== position) {
        return jsonResponse(request, env, { error:'This photo has been replaced or removed', code:'PHOTO_SUPERSEDED' }, 409);
      }
      const productCode = normalizeProductCode(sessionRecord.product_code);
      if (selected.status === 'uploaded' && selected.object_key) {
        const confirmed = await env.ARTWORK_BUCKET.head(selected.object_key);
        if (
          confirmed &&
          confirmed.customMetadata?.upload_session_id === uploadSessionId &&
          confirmed.customMetadata?.photo_id === photoId &&
          confirmed.customMetadata?.revision === revision &&
          confirmed.httpMetadata?.contentType === 'image/jpeg'
        ) {
          logUploadDiagnostic({ uploadSessionId, photoId, stage:'r2-verification', status:200, code:'', result:'uploaded' });
          return jsonResponse(request, env, {
          success:true,
          recovered:true,
          photo:{
            photoId,
            revision,
            objectKey:selected.object_key,
            position:selected.position,
            width:Number(confirmed.customMetadata?.width_px || 0),
            height:Number(confirmed.customMetadata?.height_px || 0),
            size:Number(confirmed.size || 0)
          }
          });
        }
      }
      const objectKey = productCode
        ? selected.object_key || getProductPhotoKey(productCode, selected.position, storageFolder)
        : getTemporaryPhotoKey(uploadSessionId, storageFolder, photoId, revision);
      const existing = await env.ARTWORK_BUCKET.head(objectKey);
      if (productCode && selection.some(photo =>
        photo?.photo_id !== photoId && photo?.object_key === objectKey
      )) {
        return jsonResponse(request, env, {
          error:'The selected photo position is already in use. Please retry the photo selection.',
          code:'PHOTO_POSITION_CONFLICT'
        }, 409);
      }
      if (productCode && existing && (
        existing.customMetadata?.upload_session_id !== uploadSessionId ||
        existing.customMetadata?.product_code !== productCode
      )) {
        return jsonResponse(request, env, {
          error:'The product photo folder is already in use',
          code:'PRODUCT_CODE_STORAGE_CONFLICT'
        }, 409);
      }
      if (productCode && existing && !existing.httpEtag) {
        throw new Error('The existing product photo could not be safely replaced');
      }
      uploadStage = 'image-validation';
      const bytes = await file.arrayBuffer();
      const info = await env.IMAGES.info(bytes);
      const width = Number(info?.width);
      const height = Number(info?.height);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
        throw new TinyFrameInputError('The cropped photo dimensions could not be read');
      }
      if (Math.abs((width / height) - (54 / 86)) > 0.015) {
        throw new TinyFrameInputError('The cropped photo does not match the 54 × 86 mm print ratio');
      }
      const createdAt = new Date().toISOString();
      uploadStage = 'r2-write';
      const stored = await env.ARTWORK_BUCKET.put(objectKey, bytes, {
        httpMetadata:{ contentType:'image/jpeg' },
        customMetadata:{
          upload_session_id:uploadSessionId,
          ...(productCode ? { product_code:productCode } : {}),
          photo_id:photoId,
          revision,
          position:String(selected.position),
          width_px:String(width),
          height_px:String(height),
          effective_ppi:String(Number(calculateEffectivePpi(width, height).toFixed(1))),
          status:productCode ? 'draft' : 'temporary',
          created_at:createdAt
        },
        onlyIf:existing
          ? { etagMatches:existing.httpEtag }
          : { etagDoesNotMatch:'*' }
      });
      if (stored === null) {
        const raced = await env.ARTWORK_BUCKET.head(objectKey);
        if (
          raced?.customMetadata?.upload_session_id !== uploadSessionId ||
          raced?.customMetadata?.product_code !== productCode ||
          raced?.customMetadata?.photo_id !== photoId ||
          raced?.customMetadata?.revision !== revision
        ) {
          return jsonResponse(request, env, {
            error:'The photo position changed while uploading. Please retry.',
            code:'PHOTO_POSITION_CONFLICT'
          }, 409);
        }
      }
      uploadStage = 'r2-verification';
      const confirmed = await env.ARTWORK_BUCKET.head(objectKey);
      if (
        !confirmed || Number(confirmed.size || 0) !== file.size ||
        confirmed.httpMetadata?.contentType !== 'image/jpeg' ||
        confirmed.customMetadata?.upload_session_id !== uploadSessionId ||
        (productCode && confirmed.customMetadata?.product_code !== productCode) ||
        confirmed.customMetadata?.photo_id !== photoId ||
        confirmed.customMetadata?.revision !== revision
      ) throw new Error('R2 did not confirm the stored photo');
      if (stored === null && !productCode) {
        console.info('Photo upload recovered an immutable R2 object after a retry', {
          uploadSessionId,
          photoId
        });
      }
      uploadStage = 'd1-selection-confirmation';
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = await getPhotoUploadSession(env.PRODUCT_CODES_DB, uploadSessionId);
        const currentSelection = photoUploadSelection(current);
        const activeIndex = currentSelection.findIndex(photo =>
          photo?.photo_id === photoId && photo?.revision === revision
        );
        if (!current || current.status !== 'draft' || activeIndex < 0) {
          if (!productCode) {
            await env.ARTWORK_BUCKET.delete(objectKey);
          } else {
            const storedPhoto = await env.ARTWORK_BUCKET.head(objectKey);
            const stillSelected = currentSelection.some(photo =>
              photo?.object_key === objectKey &&
              photo?.photo_id === photoId &&
              photo?.revision === revision
            );
            if (
              !stillSelected &&
              storedPhoto?.customMetadata?.upload_session_id === uploadSessionId &&
              storedPhoto.customMetadata?.product_code === productCode &&
              storedPhoto.customMetadata?.photo_id === photoId &&
              storedPhoto.customMetadata?.revision === revision
            ) await env.ARTWORK_BUCKET.delete(objectKey);
          }
          return jsonResponse(request, env, { error:'This photo was replaced while uploading', code:'PHOTO_SUPERSEDED' }, 409);
        }
        if (currentSelection[activeIndex].status === 'uploaded' && currentSelection[activeIndex].object_key) {
          if (!productCode) await env.ARTWORK_BUCKET.delete(objectKey);
          const existingKey = currentSelection[activeIndex].object_key;
          return jsonResponse(request, env, {
            success:true,
            recovered:true,
            photo:{ photoId, revision, objectKey:existingKey, position:currentSelection[activeIndex].position, width, height, size:file.size }
          });
        }
        currentSelection[activeIndex] = {
          ...currentSelection[activeIndex],
          object_key:objectKey,
          status:'uploaded'
        };
        const updated = await savePhotoUploadSelection(env.PRODUCT_CODES_DB, current, currentSelection, new Date().toISOString());
        if (updated) {
          logUploadDiagnostic({ uploadSessionId, photoId, stage:'r2-verification', status:200, code:'', result:'uploaded' });
          return jsonResponse(request, env, {
            success:true,
            photo:{ photoId, revision, objectKey, position:currentSelection[activeIndex].position, width, height, size:file.size }
          });
        }
      }
      if (!productCode) await env.ARTWORK_BUCKET.delete(objectKey);
      throw new Error('Photo selection changed repeatedly while the upload was finishing');
    }
    const bytes = await file.arrayBuffer();
    const info = await env.IMAGES.info(bytes);
    const width = Number(info?.width);
    const height = Number(info?.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new TinyFrameInputError('The cropped photo dimensions could not be read');
    }
    if (Math.abs((width / height) - (54 / 86)) > 0.015) {
      throw new TinyFrameInputError('The cropped photo does not match the 54 × 86 mm print ratio');
    }
    const objectKey = getIndividualPhotoKey(uploadSessionId, photoId);
    const existing = await env.ARTWORK_BUCKET.head(objectKey);
    if (existing) {
      const sameRevision = existing.customMetadata?.upload_session_id === uploadSessionId &&
        existing.customMetadata?.photo_id === photoId &&
        existing.customMetadata?.revision === revision &&
        Number(existing.size || 0) === file.size;
      if (!sameRevision) return jsonResponse(request, env, { error:'This photo identity is already in use' }, 409);
      return jsonResponse(request, env, { success:true, recovered:true, photo:{ photoId, objectKey, position, width, height, size:file.size } });
    }
    const stored = await env.ARTWORK_BUCKET.put(objectKey, bytes, {
      httpMetadata:{ contentType:'image/jpeg' },
      customMetadata:{
        upload_session_id:uploadSessionId,
        photo_id:photoId,
        revision,
        position:String(position),
        width_px:String(width),
        height_px:String(height),
        effective_ppi:String(Number(calculateEffectivePpi(width, height).toFixed(1))),
        status:'draft',
        created_at:new Date().toISOString()
      },
      onlyIf:{ etagDoesNotMatch:'*' }
    });
    const confirmed = await env.ARTWORK_BUCKET.head(objectKey);
    if (
      !confirmed || Number(confirmed.size || 0) !== file.size ||
      confirmed.customMetadata?.upload_session_id !== uploadSessionId ||
      confirmed.customMetadata?.photo_id !== photoId ||
      confirmed.customMetadata?.revision !== revision
    ) throw new Error('R2 did not confirm the stored photo');
    if (stored === null) {
      console.warn('Photo upload recovered an existing object after a concurrent write', {
        uploadSessionId,
        photoId
      });
    }
    return jsonResponse(request, env, { success:true, photo:{ photoId, objectKey, position, width, height, size:file.size } });
  } catch (error) {
    const status = Number(error?.status) || (error instanceof TinyFrameInputError ? 400 : 500);
    logUploadDiagnostic({
      uploadSessionId,
      photoId,
      stage:uploadStage,
      status,
      code:error instanceof TinyFrameInputError ? 'INVALID_PHOTO_UPLOAD' : 'PHOTO_UPLOAD_FAILED',
      result:'failed'
    });
    return jsonResponse(request, env, {
      error:error instanceof TinyFrameInputError ? error.message : 'The cropped photo could not be uploaded. Please retry.',
      code:error?.code || (error instanceof TinyFrameInputError ? 'INVALID_PHOTO_UPLOAD' : 'PHOTO_UPLOAD_FAILED')
    }, status);
  }
}

async function deleteIndividualTinyFramePhoto(request, env) {
  if (!env.ARTWORK_BUCKET) return jsonResponse(request, env, { error:'Photo storage is not configured' }, 503);
  if (!getAllowedOrigin(request, env)) return jsonResponse(request, env, { error:'Origin is not allowed' }, 403);
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse(request, env, { error:'Request body must be valid JSON' }, 400); }
  const uploadSessionId = normalizeUploadReference(body?.uploadSessionId);
  const photoId = normalizePhotoId(body?.photoId);
  try {
    const { sessionRecord } = await requireIndividualUploadSession(request, env, uploadSessionId);
    if (sessionRecord) {
      return jsonResponse(request, env, { error:'Update the active photo selection instead of deleting an upload directly' }, 409);
    }
    const objectKey = getIndividualPhotoKey(uploadSessionId, photoId);
    if (!objectKey) throw new TinyFrameInputError('Photo identity is invalid');
    await env.ARTWORK_BUCKET.delete(objectKey);
    return jsonResponse(request, env, { success:true });
  } catch (error) {
    return jsonResponse(request, env, { error:error.message || 'Photo could not be removed' }, error instanceof TinyFrameInputError ? 400 : 500);
  }
}

async function finalizeIndividualTinyFrameUpload(request, env) {
  if (!env.ARTWORK_BUCKET) return jsonResponse(request, env, { error:'Photo storage is not configured' }, 503);
  if (!getAllowedOrigin(request, env)) return jsonResponse(request, env, { error:'Origin is not allowed' }, 403);
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse(request, env, { error:'Request body must be valid JSON' }, 400); }
  const uploadSessionId = normalizeUploadReference(body?.uploadSessionId);
  const cartItemId = normalizeCartItemId(body?.cartItemId);
  const frameColour = normalizeFrameColour(body?.frameColour);
  const photoSetCount = normalizePhotoSetCount(body?.photoSetCount);
  const photos = Array.isArray(body?.photos) ? body.photos : [];
  const expectedPhotoCount = Number(photoSetCount) * TINY_FRAME_PHOTOS_PER_SET;
  if (
    !uploadSessionId || !cartItemId || !frameColour || !photoSetCount ||
    !Number.isSafeInteger(expectedPhotoCount)
  ) return jsonResponse(request, env, { error:'Every selected photo set must contain three uploaded photos' }, 400);
  let finalizeStage = 'session-authentication';
  try {
    const { manifestKey, manifest, sessionRecord, storageFolder } = await requireIndividualUploadSession(request, env, uploadSessionId);
    if (sessionRecord) {
      if (sessionRecord.cart_item_id !== cartItemId) throw new TinyFrameInputError('Photo upload does not match this product');
      let snapshot = parsePhotoUploadJson(sessionRecord.snapshot_json, null);
      if (['finalized', 'checkout_pending', 'paid'].includes(sessionRecord.status) && snapshot) {
        if (
          normalizeFrameColour(snapshot.frame_colour) !== frameColour ||
          Number(snapshot.photo_set_count) !== photoSetCount ||
          snapshot.photos.length !== expectedPhotoCount
        ) throw new TinyFrameInputError('This photo selection has already been finalized');
      } else {
        finalizeStage = 'selection-verification';
        if (sessionRecord.status !== 'draft') throw new TinyFrameInputError('This photo selection is no longer editable');
        const selection = photoUploadSelection(sessionRecord);
        if (
          Number(sessionRecord.photo_set_count) !== photoSetCount ||
          selection.length !== expectedPhotoCount ||
          selection.some((photo, index) =>
            !photo?.photo_id || !photo.revision || photo.status !== 'uploaded' ||
            photo.position !== index + 1 ||
            !isValidIndividualPhotoKey(photo.object_key, uploadSessionId, storageFolder)
          )
        ) throw new TinyFrameInputError('Every selected photo must finish uploading before checkout');
        finalizeStage = 'r2-verification';
        const stored = await Promise.all(selection.map(photo => env.ARTWORK_BUCKET.head(photo.object_key)));
        if (stored.some((object, index) =>
          !object ||
          object.customMetadata?.upload_session_id !== uploadSessionId ||
          (normalizeProductCode(sessionRecord.product_code) && object.customMetadata?.product_code !== sessionRecord.product_code) ||
          object.customMetadata?.photo_id !== selection[index].photo_id ||
          object.customMetadata?.revision !== selection[index].revision
        )) throw new TinyFrameInputError('One or more selected photos could not be verified in product storage');
        snapshot = {
          storage_version:INDIVIDUAL_PHOTO_STORAGE_VERSION,
          upload_session_id:uploadSessionId,
          cart_item_id:cartItemId,
          product_type:'tiny_frame_photo_sets',
          photo_set_count:photoSetCount,
          photo_count:expectedPhotoCount,
          frame_colour:frameColour,
          photos:selection.map((photo, index) => ({
            photo_id:photo.photo_id,
            revision:photo.revision,
            objectKey:photo.object_key,
            position:index + 1,
            contentType:'image/jpeg',
            size:Number(stored[index].size || 0)
          })),
          finalized_at:new Date().toISOString()
        };
        finalizeStage = 'd1-finalization';
        const updated = await env.PRODUCT_CODES_DB.prepare(
          `UPDATE photo_upload_sessions
              SET status = 'finalized',
                  snapshot_json = ?,
                  frame_colour = ?,
                  photo_set_count = ?,
                  state_version = state_version + 1,
                  updated_at = ?
            WHERE upload_session_id = ?
              AND state_version = ?
              AND selection_version = ?
              AND status = 'draft'`
        ).bind(
          JSON.stringify(snapshot),
          frameColour,
          photoSetCount,
          snapshot.finalized_at,
          uploadSessionId,
          Number(sessionRecord.state_version),
          Number(sessionRecord.selection_version)
        ).run();
        if (Number(updated?.meta?.changes ?? updated?.changes ?? 0) !== 1) {
          throw new TinyFrameInputError('The photo selection changed while checkout was starting. Please try again.');
        }
      }
      const productCodes = parsePhotoUploadJson(sessionRecord.product_codes_json, []);
      const finalizedManifest = {
        ...manifest,
        ...snapshot,
        product_codes:Array.isArray(productCodes) ? productCodes : [],
        photos:snapshot.photos,
        files:snapshot.photos,
        status:'finalized',
        updated_at:snapshot.finalized_at
      };
      finalizeStage = 'manifest-write';
      await env.ARTWORK_BUCKET.put(manifestKey, JSON.stringify(finalizedManifest), {
        httpMetadata:{ contentType:'application/json' }
      });
      return jsonResponse(request, env, {
        success:true,
        uploadSessionId,
        cartItemId,
        photoCount:expectedPhotoCount,
        selectionVersion:Number(sessionRecord.selection_version)
      });
    }
    if (photos.length !== expectedPhotoCount) {
      throw new TinyFrameInputError('Every selected photo set must contain three uploaded photos');
    }
    const normalizedPhotos = photos.map((photo, index) => ({
      photo_id:normalizePhotoId(photo?.photoId),
      objectKey:String(photo?.objectKey || ''),
      position:index + 1,
      revision:String(photo?.revision || '')
    }));
    if (
      normalizedPhotos.some((photo, index) => !photo.photo_id || photo.objectKey !== getIndividualPhotoKey(uploadSessionId, photo.photo_id) || Number(photos[index]?.position) !== index + 1) ||
      new Set(normalizedPhotos.map(photo => photo.objectKey)).size !== normalizedPhotos.length
    ) throw new TinyFrameInputError('Photo order information is invalid');
    const stored = await Promise.all(normalizedPhotos.map(photo => env.ARTWORK_BUCKET.head(photo.objectKey)));
    if (stored.some((object, index) => !object || object.customMetadata?.revision !== normalizedPhotos[index].revision)) {
      throw new TinyFrameInputError('One or more cropped photos has not finished uploading');
    }
    const updatedAt = new Date().toISOString();
    const finalized = {
      ...manifest,
      cart_item_id:cartItemId,
      frame_colour:frameColour,
      photo_set_count:photoSetCount,
      photo_count:expectedPhotoCount,
      photos:normalizedPhotos,
      files:normalizedPhotos.map(photo => ({ ...photo, contentType:'image/jpeg' })),
      status:'finalized',
      finalized_at:updatedAt,
      updated_at:updatedAt,
      uploaded_at:updatedAt
    };
    await env.ARTWORK_BUCKET.put(manifestKey, JSON.stringify(finalized), { httpMetadata:{ contentType:'application/json' } });
    return jsonResponse(request, env, { success:true, uploadSessionId, cartItemId, photoCount:expectedPhotoCount });
  } catch (error) {
    const status = error instanceof TinyFrameInputError ? 400 : 500;
    console.error('Photo upload finalization failed', {
      sessionId:uploadSessionId || 'invalid',
      stage:finalizeStage,
      status,
      code:error instanceof TinyFrameInputError ? 'INVALID_UPLOAD_FINALIZATION' : 'UPLOAD_FINALIZATION_FAILED'
    });
    return jsonResponse(request, env, {
      error:error.message || 'Photo upload could not be finalized',
      code:error instanceof TinyFrameInputError ? 'INVALID_UPLOAD_FINALIZATION' : 'UPLOAD_FINALIZATION_FAILED'
    }, status);
  }
}

async function getIndividualTinyFrameUploadStatus(request, env) {
  if (!env.ARTWORK_BUCKET) return jsonResponse(request, env, { error:'Photo storage is not configured' }, 503);
  if (!getAllowedOrigin(request, env)) return jsonResponse(request, env, { error:'Origin is not allowed' }, 403);
  const uploadSessionId = normalizeUploadReference(new URL(request.url).searchParams.get('upload_session_id'));
  try {
    const { manifest, sessionRecord } = await requireIndividualUploadSession(request, env, uploadSessionId);
    if (sessionRecord) {
      const selection = photoUploadSelection(sessionRecord);
      return jsonResponse(request, env, {
        success:true,
        uploadSessionId,
        status:sessionRecord.status,
        photoSetCount:Number(sessionRecord.photo_set_count || 0),
        selectionVersion:Number(sessionRecord.selection_version || 0),
        photos:selection.filter(photo => photo?.status === 'uploaded' && photo.object_key).map(photo => ({
          photoId:photo.photo_id,
          objectKey:photo.object_key,
          position:Number(photo.position || 0),
          revision:photo.revision
        }))
      });
    }
    const storedPhotos = [];
    let cursor;
    do {
      const page = await env.ARTWORK_BUCKET.list({
        prefix:`${getTinyFrameUploadPrefix(uploadSessionId)}photos/`,
        ...(cursor ? { cursor } : {})
      });
      const objects = Array.isArray(page?.objects) ? page.objects : [];
      const details = await Promise.all(objects.map(object => env.ARTWORK_BUCKET.head(object.key)));
      details.forEach((object, index) => {
        const metadata = object?.customMetadata || {};
        const photoId = normalizePhotoId(metadata.photo_id);
        if (!photoId || !isValidIndividualPhotoKey(objects[index].key, uploadSessionId)) return;
        storedPhotos.push({
          photoId,
          objectKey:objects[index].key,
          position:Number(metadata.position || 0),
          revision:String(metadata.revision || '')
        });
      });
      cursor = page?.truncated ? page.cursor : undefined;
    } while (cursor);
    storedPhotos.sort((a, b) => a.position - b.position);
    return jsonResponse(request, env, {
      success:true,
      uploadSessionId,
      status:manifest.status,
      photoCount:Number(manifest.photo_count || 0),
      photos:storedPhotos.length
        ? storedPhotos
        : (Array.isArray(manifest.photos) ? manifest.photos : []).map(({ photo_id, objectKey, position, revision }) => ({ photoId:photo_id, objectKey, position, revision }))
    });
  } catch (error) {
    const status = error instanceof TinyFrameInputError ? 400 : 500;
    console.error('Photo upload status check failed', {
      sessionId:uploadSessionId || 'invalid',
      stage:'status-read',
      status,
      code:error instanceof TinyFrameInputError ? 'INVALID_UPLOAD_STATUS' : 'UPLOAD_STATUS_FAILED'
    });
    return jsonResponse(request, env, {
      error:error.message || 'Upload session could not be read',
      code:error instanceof TinyFrameInputError ? 'INVALID_UPLOAD_STATUS' : 'UPLOAD_STATUS_FAILED'
    }, status);
  }
}

async function uploadArtwork(request, env) {
  if (!env.ARTWORK_BUCKET) {
    return jsonResponse(request, env, { error: 'Artwork storage is not configured' }, 503);
  }
  if (!getAllowedOrigin(request, env)) {
    return jsonResponse(request, env, { error: 'Origin is not allowed' }, 403);
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse(request, env, { error: 'Upload must use multipart form data' }, 400);
  }

  const file = formData.get('file');
  const kind = String(formData.get('kind') || '');
  let uploadId;
  try {
    uploadId = sanitizeUploadId(formData.get('uploadId'));
  } catch (error) {
    return jsonResponse(request, env, { error: error.message }, 400);
  }
  if (!file || typeof file.arrayBuffer !== 'function') {
    return jsonResponse(request, env, { error: 'An artwork file is required' }, 400);
  }

  let objectKey;
  try {
    if (kind === 'original') {
      objectKey = createOriginalObjectKey(uploadId, file, new Date());
      if (await env.ARTWORK_BUCKET.head(objectKey)) {
        return jsonResponse(request, env, { error: 'Upload ID already exists' }, 409);
      }
    } else if (kind === 'thumbnail') {
      if (file.type !== 'image/png') {
        throw new Error('Thumbnail must be a PNG image');
      }
      objectKey = createThumbnailObjectKey(formData.get('originalObjectKey'), uploadId);
      const originalKey = String(formData.get('originalObjectKey'));
      if (!await env.ARTWORK_BUCKET.head(originalKey)) {
        return jsonResponse(request, env, { error: 'Original artwork was not found' }, 404);
      }
    } else {
      throw new Error('Upload kind is invalid');
    }
  } catch (error) {
    return jsonResponse(request, env, { error: error.message }, 400);
  }

  await env.ARTWORK_BUCKET.put(objectKey, file.stream(), {
    httpMetadata: { contentType: file.type }
  });
  return jsonResponse(request, env, {
    objectKey,
    url: getArtworkUrl(request, objectKey)
  });
}

async function createArtworkManifest(request, env) {
  if (!env.ARTWORK_BUCKET) {
    return jsonResponse(request, env, { error: 'Artwork storage is not configured' }, 503);
  }
  if (!getAllowedOrigin(request, env)) {
    return jsonResponse(request, env, { error: 'Origin is not allowed' }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, env, { error: 'Request body must be valid JSON' }, 400);
  }

  const uploadReference = normalizeUploadReference(body.uploadReference);
  const artworkObjectKeys = Array.isArray(body.artworkObjectKeys) ? body.artworkObjectKeys : [];
  if (
    !uploadReference ||
    artworkObjectKeys.length !== 8 ||
    !artworkObjectKeys.every(isValidArtworkObjectKey) ||
    new Set(artworkObjectKeys).size !== 8
  ) {
    return jsonResponse(request, env, { error: 'A picture order requires one valid reference and eight unique uploads' }, 400);
  }

  for (const objectKey of artworkObjectKeys) {
    if (!await env.ARTWORK_BUCKET.head(objectKey)) {
      return jsonResponse(request, env, { error: 'One or more uploaded photos could not be found' }, 400);
    }
  }

  const manifestKey = getLegacyUploadManifestKey(uploadReference);
  if (await env.ARTWORK_BUCKET.head(manifestKey)) {
    return jsonResponse(request, env, { error: 'Upload reference already exists' }, 409);
  }
  await env.ARTWORK_BUCKET.put(manifestKey, JSON.stringify({
    uploadReference,
    artworkObjectKeys,
    createdAt: new Date().toISOString()
  }), {
    httpMetadata: { contentType: 'application/json' }
  });

  return jsonResponse(request, env, { uploadReference });
}

async function getArtwork(request, env, objectKey) {
  if (!env.ARTWORK_BUCKET || (!isValidArtworkObjectKey(objectKey) && !isValidTinyFramePrintSheetKey(objectKey))) {
    return new Response('Not found', { status: 404 });
  }
  const object = await env.ARTWORK_BUCKET.get(objectKey);
  if (!object) {
    return new Response('Not found', { status: 404 });
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', 'private, max-age=3600');
  const allowedOrigin = getAllowedOrigin(request, env);
  if (allowedOrigin) {
    headers.set('Access-Control-Allow-Origin', allowedOrigin);
    headers.set('Vary', 'Origin');
  }
  return new Response(object.body, { headers });
}

function cleanText(value, fallback) {
  const text = typeof value === 'string' ? value : fallback;
  return text.replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
}

function normalizeTinyFrameOrderType(value) {
  const normalized = cleanText(value, '').toLowerCase();
  if (['frame-plus-pictures', 'frame + eight photos', 'frame plus eight photos', 'frame + 8 photos', 'frame plus 8 photos', 'frame + 8 pictures', 'frame plus 8 pictures'].includes(normalized)) {
    return 'frame-plus-pictures';
  }
  if (normalized === 'frame-only' || normalized === 'frame only' || /^frame \+ [0-9]+ photos$/.test(normalized)) return 'photo-sets';
  return '';
}

function normalizeTinyFrameProductType(item) {
  const explicitProductType = cleanText(item?.productType, '').toLowerCase();
  if (TINY_FRAME_PRODUCTS[explicitProductType]) {
    return explicitProductType;
  }
  const orderType = normalizeTinyFrameOrderType(item?.orderType);
  if (orderType === 'frame-plus-pictures') return 'tiny_frame_8_pictures';
  if (orderType === 'photo-sets') return 'tiny_frame_photo_sets';
  return '';
}

function normalizeFrameColour() {
  return 'Natural Oak';
}

function normalizeUploadReference(value) {
  const reference = cleanText(value, '').toLowerCase();
  return /^tf_[a-f0-9]{32}$/.test(reference) ? reference : '';
}

function normalizePictureUploadReference(value) {
  return normalizeUploadReference(cleanText(value, ''));
}

function getUnitAmount(item, size, productType) {
  if (size !== '80x80mm') {
    return PRICE_BY_SIZE[size];
  }
  const photoSetCount = productType === 'tiny_frame_8_pictures' ? 0 : normalizePhotoSetCount(item?.photoSetCount);
  return getTinyFrameUnitAmount(productType, photoSetCount);
}

function getLegacyProductName(item) {
  const productName = item?.price_data?.product_data?.name;
  return typeof productName === 'string' ? productName : '';
}

function normalizeRequestedSize(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const dimensions = value
    .toLowerCase()
    .replace(/[\u00d7*]/g, 'x')
    .match(/(\d+)\s*x\s*(\d+)\s*mm/);

  if (!dimensions) {
    return null;
  }

  const width = Number(dimensions[1]);
  const height = Number(dimensions[2]);
  const dimensionKey = [width, height]
    .sort((a, b) => a - b)
    .join('x');

  return CANONICAL_SIZE_BY_DIMENSIONS[dimensionKey] || null;
}

function getRequestedSize(item) {
  return normalizeRequestedSize(item?.size) ||
    normalizeRequestedSize(getLegacyProductName(item));
}

function buildLineItems(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 10) {
    throw new Error('Cart must contain between 1 and 10 items');
  }

  const lineItems = [];
  let physicalProductCount = 0;

  items.forEach(item => {
    if (getLegacyProductName(item).trim().toLowerCase() === 'shipping') {
      return;
    }

    const size = getRequestedSize(item);
    const productType = size === '80x80mm' ? normalizeTinyFrameProductType(item) : '';
    const tinyFrameProduct = TINY_FRAME_PRODUCTS[productType];
    const photoSetCount = productType === 'tiny_frame_8_pictures' ? 0 : normalizePhotoSetCount(item?.photoSetCount);
    const photoCount = tinyFrameProduct && photoSetCount !== null
      ? getTinyFramePhotoCount(productType, photoSetCount)
      : 0;
    const unitAmount = getUnitAmount(item, size, productType);

    if (!unitAmount || (productType === 'tiny_frame_photo_sets' && photoSetCount === null)) {
      throw new Error(size === '80x80mm'
        ? 'One or more Tiny Frames has an invalid product type'
        : 'One or more cart items has an invalid frame size');
    }

    const requestedQuantity = Number(item.quantity);
    const quantity = Number.isInteger(requestedQuantity) && requestedQuantity >= 1 && requestedQuantity <= 10
      ? requestedQuantity
      : 1;
    const cartItemId = normalizeCartItemId(item.cartItemId || item.id);
    const submittedProductCode = item.productCode === undefined || item.productCode === null || String(item.productCode).trim() === ''
      ? ''
      : normalizeProductCode(item.productCode);
    const frameColour = normalizeFrameColour(item.frameColour || item.frameColor);
    const uploadReference = normalizePictureUploadReference(item.uploadReference || item.uploadId);
    const artworkObjectKeys = Array.isArray(item.artworkObjectKeys)
      ? item.artworkObjectKeys.filter(isValidArtworkObjectKey).slice(0, 8)
      : [];
    if (!cartItemId) {
      throw new Error('One or more cart products has an invalid durable identity');
    }
    if (item.productCode && !submittedProductCode) {
      throw new Error('One or more cart products has an invalid product code');
    }
    if (tinyFrameProduct?.requiresPictures && !uploadReference) {
      throw new Error('Frame + Eight Photos requires a completed photo upload reference');
    }
    if (productType === 'tiny_frame_photo_sets') {
      if (Number(item.photoCount) !== photoCount) {
        throw new Error('The photo count does not match the selected photo sets');
      }
      if (photoCount > 0 && !uploadReference) {
        throw new Error('Every photo set requires a completed photo upload reference');
      }
      if (photoCount === 0 && uploadReference) {
        throw new Error('A frame-only product cannot include a photo upload reference');
      }
    }
    const customerFacingName = tinyFrameProduct
      ? tinyFrameNameFor(productType, photoCount)
      : `Print & Frame - ${size}`;

    for (let unitIndex = 0; unitIndex < quantity; unitIndex += 1) {
      lineItems.push({
        name:customerFacingName,
        unitAmount,
        quantity:1,
        cartItemId,
        unitIndex,
        productCode:submittedProductCode,
        productType:productType || 'print_frame',
        frameColour,
        uploadReference,
        photoSetCount:productType === 'tiny_frame_8_pictures' ? 0 : photoSetCount,
        photoCount,
        originalObjectKey: isValidArtworkObjectKey(item.originalObjectKey) ? item.originalObjectKey : '',
        thumbnailObjectKey: isValidArtworkObjectKey(item.thumbnailObjectKey) ? item.thumbnailObjectKey : '',
        artworkObjectKeys,
        size
      });
      physicalProductCount += 1;
    }
  });

  if (lineItems.length === 0) {
    throw new Error('Cart does not contain any purchasable items');
  }
  if (physicalProductCount > 99) {
    throw new Error('Cart cannot contain more than 99 physical products');
  }

  return lineItems;
}

function chunkStripeMetadataEntries(entries, maximumLength = 500) {
  const chunks = [];
  let chunk = '';
  for (const entry of entries) {
    if (entry.length > maximumLength) throw new Error('A Stripe product mapping entry is too long');
    const candidate = chunk ? `${chunk}; ${entry}` : entry;
    if (candidate.length <= maximumLength) {
      chunk = candidate;
      continue;
    }
    chunks.push(chunk);
    chunk = entry;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function chunkStripeMetadataValues(values, maximumLength = 500) {
  const chunks = [];
  let chunk = '';
  for (const value of values) {
    if (value.length > maximumLength) throw new Error('A Stripe metadata value is too long');
    const candidate = chunk ? `${chunk},${value}` : value;
    if (candidate.length <= maximumLength) {
      chunk = candidate;
      continue;
    }
    chunks.push(chunk);
    chunk = value;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function createStripeProductMapping(lineItems) {
  const entries = lineItems
    .filter(item => item.productCode)
    .map((item, index) => {
      const price = `AUD ${(item.unitAmount / 100).toFixed(2)}`;
      const artwork = item.photoCount > 0
        ? ` | ${item.photoCount} photos | Upload ${item.uploadReference}`
        : '';
      return `${index + 1}:${item.productCode} | ${item.frameColour} | ${item.name} | ${price}${artwork}`;
    });
  return chunkStripeMetadataEntries(entries);
}

function createStripePayload(
  lineItems,
  siteBaseUrl,
  stripeMode = 'live',
  checkoutRequestId = '',
  shippingCountry = 'AU',
  internationalShippingRateId = ''
) {
  const productCodes = lineItems.map(item => item.productCode).filter(Boolean);
  const productTypes = lineItems.map(item => item.productType).filter(Boolean);
  const frameColours = lineItems.map(item => item.frameColour).filter(Boolean);
  const uploadReferences = [...new Set(lineItems.map(item => item.uploadReference).filter(Boolean))];
  const payload = new URLSearchParams({
    mode: 'payment',
    success_url: `${siteBaseUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteBaseUrl}/?checkout=cancelled#cart`,
    billing_address_collection: 'required',
    'shipping_address_collection[allowed_countries][0]': shippingCountry
  });

  if (shippingCountry === 'AU') {
    payload.set('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
    payload.set('shipping_options[0][shipping_rate_data][display_name]', 'Shipping');
    payload.set('shipping_options[0][shipping_rate_data][fixed_amount][amount]', String(SHIPPING_AMOUNT));
    payload.set('shipping_options[0][shipping_rate_data][fixed_amount][currency]', 'aud');
  } else {
    payload.set('shipping_options[0][shipping_rate]', internationalShippingRateId);
  }

  payload.set('metadata[stripe_mode]', stripeMode);
  payload.set('payment_intent_data[metadata][stripe_mode]', stripeMode);
  payload.set('metadata[shipping_country]', shippingCountry);
  payload.set('payment_intent_data[metadata][shipping_country]', shippingCountry);
  payload.set('metadata[checkout_request_id]', checkoutRequestId);
  payload.set('payment_intent_data[metadata][checkout_request_id]', checkoutRequestId);
  const productCodeChunks = [];
  for (let index = 0; index < productCodes.length; index += 80) {
    productCodeChunks.push(productCodes.slice(index, index + 80).join(','));
  }
  productCodeChunks.forEach((value, index) => {
    const suffix = productCodeChunks.length === 1 ? '' : `_${index + 1}`;
    payload.set(`metadata[product_codes${suffix}]`, value);
    payload.set(`payment_intent_data[metadata][product_codes${suffix}]`, value);
  });
  createStripeProductMapping(lineItems).forEach((value, index) => {
    const suffix = index === 0 ? '' : `_${index + 1}`;
    payload.set(`metadata[product_map${suffix}]`, value);
    payload.set(`payment_intent_data[metadata][product_map${suffix}]`, value);
  });
  if (stripeMode === 'test') {
    payload.set(
      'custom_text[submit][message]',
      'TEST MODE — no real payment, fulfilment, shipping, or customer notification will occur.'
    );
  }

  payload.set('payment_intent_data[description]', 'Good Frame Order');
  if (productTypes.length > 0) {
    payload.set('metadata[product_types]', productTypes.join(',').slice(0, 500));
    payload.set('payment_intent_data[metadata][product_types]', productTypes.join(',').slice(0, 500));
  }
  if (frameColours.length > 0) {
    payload.set('metadata[frame_colours]', frameColours.join(',').slice(0, 500));
    payload.set('payment_intent_data[metadata][frame_colours]', frameColours.join(',').slice(0, 500));
  }
  if (uploadReferences.length > 0) {
    const uploadReferenceChunks = chunkStripeMetadataValues(uploadReferences);
    uploadReferenceChunks.forEach((value, index) => {
      const suffix = index === 0 ? '' : `_${index}`;
      payload.set(`metadata[upload_references${suffix}]`, value);
      payload.set(`payment_intent_data[metadata][upload_references${suffix}]`, value);
      payload.set(`metadata[upload_session_ids${suffix}]`, value);
      payload.set(`payment_intent_data[metadata][upload_session_ids${suffix}]`, value);
    });
  }

  lineItems.forEach((item, index) => {
    const prefix = `line_items[${index}]`;
    payload.set(`${prefix}[price_data][currency]`, 'aud');
    payload.set(`${prefix}[price_data][product_data][name]`, item.name);
    if (item.productType) {
      payload.set(`${prefix}[price_data][product_data][metadata][product_type]`, item.productType);
      payload.set(`${prefix}[price_data][product_data][metadata][frame_colour]`, item.frameColour);
      payload.set(`${prefix}[price_data][product_data][metadata][product_code]`, item.productCode);
      payload.set(`${prefix}[price_data][product_data][metadata][cart_item_id]`, item.cartItemId);
      payload.set(`${prefix}[price_data][product_data][metadata][unit_index]`, String(item.unitIndex));
      payload.set(`${prefix}[price_data][product_data][metadata][photo_set_count]`, String(item.photoSetCount || 0));
      payload.set(`${prefix}[price_data][product_data][metadata][photo_count]`, String(item.photoCount || 0));
      if (item.uploadReference) {
        payload.set(`${prefix}[price_data][product_data][metadata][upload_reference]`, item.uploadReference);
        payload.set(`${prefix}[price_data][product_data][metadata][upload_session_id]`, item.uploadReference);
      }
    }
    if (item.productCode) {
      payload.set(`${prefix}[price_data][product_data][metadata][frame_size]`, item.size);
      if (item.originalObjectKey) {
        payload.set(`${prefix}[price_data][product_data][metadata][original_object_key]`, item.originalObjectKey);
      }
      if (item.thumbnailObjectKey) {
        payload.set(`${prefix}[price_data][product_data][metadata][thumbnail_object_key]`, item.thumbnailObjectKey);
      }
      if (item.artworkObjectKeys.length) {
        payload.set(
          `${prefix}[price_data][product_data][metadata][artwork_object_keys]`,
          item.artworkObjectKeys.join(',').slice(0, 500)
        );
      }
    }
    payload.set(`${prefix}[price_data][unit_amount]`, String(item.unitAmount));
    payload.set(`${prefix}[quantity]`, String(item.quantity));
  });

  return payload;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function createCheckoutPayloadFingerprint(lineItems, shippingCountry, shippingRateIdentity) {
  return JSON.stringify({
    shippingCountry,
    shippingRateIdentity,
    lineItems:lineItems.map(item => ({
      cartItemId:item.cartItemId || '',
      unitIndex:Number.isInteger(item.unitIndex) ? item.unitIndex : -1,
      productCode:item.productCode || '',
      productType:item.productType || '',
      size:item.size || '',
      frameColour:item.frameColour || '',
      uploadReference:item.uploadReference || '',
      photoSetCount:item.photoSetCount || 0,
      photoCount:item.photoCount || 0,
      unitAmount:item.unitAmount,
      quantity:item.quantity
    }))
  });
}

async function verifyUploadManifests(lineItems, env) {
  const pictureItems = lineItems.filter(item => item.productType === 'tiny_frame_8_pictures' || (item.productType === 'tiny_frame_photo_sets' && item.photoCount > 0));
  if (!pictureItems.length) return;
  if (!env.ARTWORK_BUCKET) throw new Error('Artwork storage is not configured');
  for (const item of pictureItems) {
    if (normalizeUploadReference(item.uploadReference)) {
      const uploadSessionId = item.uploadReference;
      const record = await getPhotoUploadSession(env.PRODUCT_CODES_DB, uploadSessionId);
      const storageFolder = getPhotoUploadStorageFolder(record, uploadSessionId);
      let manifestKey = getUploadManifestKey(uploadSessionId, storageFolder);
      let manifestObject = await env.ARTWORK_BUCKET.get(manifestKey);
      if (!manifestObject) {
        manifestKey = getLegacyIndividualUploadManifestKey(item.uploadReference);
        manifestObject = await env.ARTWORK_BUCKET.get(manifestKey);
      }
      const manifest = await readR2Json(manifestObject);
      if (manifest?.storage_version === INDIVIDUAL_PHOTO_STORAGE_VERSION) {
        const snapshot = parsePhotoUploadJson(record?.snapshot_json, null);
        const photos = Array.isArray(snapshot?.photos) ? snapshot.photos : [];
        if (
          !record || record.cart_item_id !== item.cartItemId ||
          (record.product_code && record.product_code !== item.productCode) ||
          !['finalized', 'checkout_pending'].includes(record.status) ||
          snapshot?.upload_session_id !== uploadSessionId ||
          snapshot.cart_item_id !== item.cartItemId ||
          normalizeFrameColour(snapshot.frame_colour) !== item.frameColour ||
          Number(snapshot.photo_set_count) !== item.photoSetCount ||
          Number(snapshot.photo_count) !== item.photoCount ||
          photos.length !== item.photoCount
        ) throw new Error('The current selected-photo snapshot could not be verified');
        const storedPhotos = await Promise.all(photos.map(photo => env.ARTWORK_BUCKET.head(String(photo?.objectKey || ''))));
        if (storedPhotos.some((photo, index) =>
          !photo ||
          !isValidIndividualPhotoKey(photos[index]?.objectKey, uploadSessionId, storageFolder) ||
          photo.customMetadata?.upload_session_id !== uploadSessionId ||
          (normalizeProductCode(record.product_code) && photo.customMetadata?.product_code !== record.product_code) ||
          photo.customMetadata?.photo_id !== photos[index]?.photo_id ||
          photo.customMetadata?.revision !== photos[index]?.revision
        )) throw new Error('One or more selected photos could not be verified in product storage');
        const assignedCodes = parsePhotoUploadJson(record.product_codes_json, []);
        if (Array.isArray(assignedCodes) && assignedCodes.some(code => normalizeProductCode(code) !== item.productCode)) {
          throw new Error('The upload session is already associated with another product code');
        }
        const productCodes = [...new Set([...(Array.isArray(assignedCodes) ? assignedCodes : []), item.productCode])];
        await env.PRODUCT_CODES_DB.prepare(
          `UPDATE photo_upload_sessions
              SET product_codes_json = ?, updated_at = ?
            WHERE upload_session_id = ?
              AND cart_item_id = ?
              AND status IN ('finalized', 'checkout_pending')`
        ).bind(JSON.stringify(productCodes), new Date().toISOString(), uploadSessionId, item.cartItemId).run();
        continue;
      }
      if (manifest?.storage_version === LEGACY_INDIVIDUAL_PHOTO_STORAGE_VERSION) {
        const photos = Array.isArray(manifest.photos) ? manifest.photos : [];
        if (
          manifest.status !== 'finalized' || manifest.cart_item_id !== item.cartItemId ||
          normalizeFrameColour(manifest.frame_colour) !== item.frameColour || Number(manifest.photo_set_count) !== item.photoSetCount ||
          Number(manifest.photo_count) !== item.photoCount || photos.length !== item.photoCount
        ) throw new Error('One or more individual-photo manifests could not be verified');
        const storedPhotos = await Promise.all(photos.map(photo => env.ARTWORK_BUCKET.head(String(photo?.objectKey || ''))));
        if (storedPhotos.some((photo, index) => !photo || !isValidIndividualPhotoKey(photos[index]?.objectKey, item.uploadReference))) {
          throw new Error('One or more cropped photos could not be verified');
        }
        const productCodes = [...new Set([...(Array.isArray(manifest.product_codes) ? manifest.product_codes : []), item.productCode].map(normalizeProductCode).filter(Boolean))];
        await env.ARTWORK_BUCKET.put(manifestKey, JSON.stringify({ ...manifest, product_codes:productCodes, updated_at:new Date().toISOString() }), {
          httpMetadata:{ contentType:'application/json' }
        });
        continue;
      }
    }
    throw new Error('This older photo upload must be added to the cart again before checkout');
  }
}

function createServerCheckoutRequestId() {
  return `co_${crypto.randomUUID().replaceAll('-', '')}`;
}

function applyAttachedProductCodes(lineItems, rows) {
  const codesByUnit = new Map(rows.map(row => [
    `${row.cart_item_id}:${Number(row.unit_index)}`,
    String(row.code)
  ]));
  return lineItems.map(item => {
    if (!item.cartItemId) return item;
    const productCode = codesByUnit.get(`${item.cartItemId}:${item.unitIndex}`);
    return productCode ? { ...item, productCode } : item;
  });
}

async function retrieveStripeSession(stripeConfiguration, sessionId) {
  let response;
  let session;
  try {
    response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers:{ Authorization:`Bearer ${stripeConfiguration.secretKey}` }
    });
    session = await response.json();
  } catch {
    throw new ProductCodeError('Checkout status could not be confirmed. Please try again');
  }
  if (!response.ok || session?.id !== sessionId) {
    throw new ProductCodeError('Checkout status could not be confirmed. Please try again');
  }
  return session;
}

async function expireStripeSession(stripeConfiguration, sessionId) {
  let response;
  let session;
  try {
    response = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
      {
        method:'POST',
        headers:{
          Authorization:`Bearer ${stripeConfiguration.secretKey}`,
          'Content-Type':'application/x-www-form-urlencoded'
        }
      }
    );
    session = await response.json();
  } catch {
    throw new ProductCodeError('The previous checkout could not be refreshed safely. Please try again');
  }
  if (!response.ok || session?.id !== sessionId || session?.status !== 'expired') {
    throw new ProductCodeError('The previous checkout could not be refreshed safely. Please try again');
  }
  return session;
}

async function reconcileCheckoutAttachment(
  lineItems,
  checkoutRequestId,
  shippingCountry,
  shippingRateIdentity,
  env,
  stripeConfiguration
) {
  const physicalItems = lineItems.filter(item => item.cartItemId);
  const attachment = await findCheckoutAttachment(env.PRODUCT_CODES_DB, physicalItems);
  if (!attachment) return { lineItems, checkoutRequestId, reused:null };

  const previousRequest = attachment.request;
  const previousRequestId = String(previousRequest.request_id);
  const attachedLineItems = applyAttachedProductCodes(lineItems, attachment.rows);
  const productCodes = attachedLineItems.map(item => item.productCode).filter(Boolean);
  const payloadHash = await sha256Hex(createCheckoutPayloadFingerprint(
    attachedLineItems,
    shippingCountry,
    shippingRateIdentity
  ));
  const samePayload = previousRequest.payload_hash === payloadHash &&
    previousRequest.product_codes === JSON.stringify(productCodes);
  if (!previousRequest.stripe_checkout_session_id) {
    if (!samePayload) {
      throw new ProductCodeError('The previous checkout is still being recovered. Please try again shortly');
    }
    return { lineItems:attachedLineItems, checkoutRequestId:previousRequestId, reused:null };
  }

  const sessionId = String(previousRequest.stripe_checkout_session_id);
  const attachedProductCodes = attachment.rows
    .filter(row => row.checkout_request_id === previousRequestId && row.stripe_checkout_session_id === sessionId)
    .map(row => String(row.code));
  const session = await retrieveStripeSession(stripeConfiguration, sessionId);
  const isPaid = session.payment_status === 'paid' || attachment.rows.some(row => row.status === 'paid');

  if (isPaid) {
    if (stripeConfiguration.mode === 'live') {
      await markProductCodesPaid(env.PRODUCT_CODES_DB, session);
    }
    throw new ProductCodeError('This cart has already been paid. Please refresh to view the confirmed order');
  }
  if (session.status === 'complete') {
    throw new ProductCodeError('Payment for this cart is already being confirmed. Please wait a moment and refresh');
  }

  if (session.status === 'open' && samePayload && previousRequest.stripe_checkout_url) {
    return {
      lineItems:attachedLineItems,
      checkoutRequestId:previousRequestId,
      reused:{
        id:sessionId,
        url:session.url || previousRequest.stripe_checkout_url,
        stripeMode:stripeConfiguration.mode,
        checkoutRequestId:previousRequestId,
        productCodes
      }
    };
  }

  if (session.status === 'open') {
    await expireStripeSession(stripeConfiguration, sessionId);
  } else if (session.status !== 'expired') {
    throw new ProductCodeError('The previous checkout cannot be replaced safely. Please contact support');
  }

  const nextRequestId = checkoutRequestId === previousRequestId
    ? createServerCheckoutRequestId()
    : checkoutRequestId;
  await moveReservedProductsToCheckoutRequest(
    env.PRODUCT_CODES_DB,
    previousRequestId,
    nextRequestId,
    sessionId,
    attachedProductCodes
  );
  return { lineItems:attachedLineItems, checkoutRequestId:nextRequestId, reused:null };
}

async function createCheckoutSession(request, env) {
  const stripeConfiguration = getStripeConfiguration(env);
  if (!stripeConfiguration) {
    return jsonResponse(request, env, { error: 'Checkout is not configured' }, 503);
  }

  if (!getAllowedOrigin(request, env)) {
    return jsonResponse(request, env, { error: 'Origin is not allowed' }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, env, { error: 'Request body must be valid JSON' }, 400);
  }

  let checkoutRequestId = normalizeCheckoutRequestId(body.checkoutRequestId);
  let checkoutItems = Array.isArray(body.items) ? body.items : [];
  const shippingCountry = normalizeShippingCountry(body.shippingCountry, 'AU');
  if (!shippingCountry) {
    return jsonResponse(request, env, { error:'Shipping country is not supported' }, 400);
  }
  let shippingQuote;
  try {
    shippingQuote = await retrieveShippingQuote(env, stripeConfiguration, shippingCountry);
  } catch (error) {
    console.error('Stripe shipping-rate validation failed', { message:error.message });
    return jsonResponse(request, env, { error:error.message }, 503);
  }
  const internationalShippingRateId = shippingQuote.rateId || '';
  const shippingRateIdentity = [
    internationalShippingRateId || 'inline-australia',
    shippingQuote.currency,
    shippingQuote.amount
  ].join(':');
  if (!checkoutRequestId) {
    const legacyRequestHash = await sha256Hex(JSON.stringify(checkoutItems));
    checkoutRequestId = `co_${legacyRequestHash.slice(0, 32)}`;
  }
  checkoutItems = await Promise.all(checkoutItems.map(async (item, index) => {
    if (normalizeCartItemId(item?.cartItemId || item?.id)) return item;
    const legacyItemHash = await sha256Hex(JSON.stringify({
      checkoutRequestId,
      index,
      uniqueCode:item?.uniqueCode || item?.orderCode || '',
      productType:item?.productType || '',
      uploadReference:item?.uploadReference || item?.uploadId || '',
      frameColour:item?.frameColour || item?.frameColor || '',
      quantity:item?.quantity || 1
    }));
    return { ...item, cartItemId:`ci_${legacyItemHash.slice(0, 32)}` };
  }));
  if (!env.PRODUCT_CODES_DB) {
    return jsonResponse(request, env, { error:'Product identification database is not configured' }, 503);
  }

  let lineItems;
  let capacity;
  try {
    lineItems = buildLineItems(checkoutItems);
    const reconciliation = await reconcileCheckoutAttachment(
      lineItems,
      checkoutRequestId,
      shippingCountry,
      shippingRateIdentity,
      env,
      stripeConfiguration
    );
    lineItems = reconciliation.lineItems;
    checkoutRequestId = reconciliation.checkoutRequestId;
    if (reconciliation.reused) {
      return jsonResponse(request, env, reconciliation.reused);
    }
    const physicalItems = lineItems.filter(item => item.cartItemId);
    const allocation = await reserveProductCodes(env.PRODUCT_CODES_DB, physicalItems, checkoutRequestId);
    capacity = allocation.capacity;
    let physicalIndex = 0;
    lineItems = lineItems.map(item => item.cartItemId ? allocation.units[physicalIndex++] : item);
    const payloadHash = await sha256Hex(createCheckoutPayloadFingerprint(
      lineItems,
      shippingCountry,
      shippingRateIdentity
    ));
    const checkoutRequest = await beginCheckoutRequest(
      env.PRODUCT_CODES_DB,
      checkoutRequestId,
      payloadHash,
      allocation.units.map(item => item.productCode)
    );
    await verifyUploadManifests(lineItems, env);
    if (checkoutRequest.stripe_checkout_session_id && checkoutRequest.stripe_checkout_url) {
      const existingStripeSession = await retrieveStripeSession(
        stripeConfiguration,
        checkoutRequest.stripe_checkout_session_id
      );
      await markUploadSessionsCheckoutPending(lineItems, existingStripeSession, env);
      return jsonResponse(request, env, {
        id:checkoutRequest.stripe_checkout_session_id,
        url:checkoutRequest.stripe_checkout_url,
        stripeMode:stripeConfiguration.mode,
        checkoutRequestId,
        productCodes:allocation.units.map(item => item.productCode)
      });
    }
  } catch (error) {
    const status = error instanceof ProductCodeCapacityError ? 503 : error instanceof ProductCodeError ? 409 : 400;
    return jsonResponse(request, env, { error:error.message }, status);
  }
  if (capacity?.low) {
    console.warn('Five-digit product code capacity is running low', capacity);
  }

  const siteBaseUrl = getSiteBaseUrl(env);
  if (!siteBaseUrl) {
    return jsonResponse(request, env, { error: 'Checkout is not configured' }, 503);
  }
  const stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeConfiguration.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key':checkoutRequestId
    },
    body:createStripePayload(
      lineItems,
      siteBaseUrl,
      stripeConfiguration.mode,
      checkoutRequestId,
      shippingCountry,
      internationalShippingRateId
    )
  });
  const stripeResult = await stripeResponse.json();

  if (!stripeResponse.ok) {
    console.error('Stripe checkout request failed', {
      status: stripeResponse.status,
      type: stripeResult?.error?.type,
      code: stripeResult?.error?.code
    });
    return jsonResponse(request, env, { error: 'Stripe could not create the checkout session' }, 502);
  }

  try {
    await markUploadSessionsCheckoutPending(lineItems, stripeResult, env);
    await completeCheckoutRequest(env.PRODUCT_CODES_DB, checkoutRequestId, stripeResult);
  } catch (error) {
    console.error('Checkout product identity persistence failed:', error);
    return jsonResponse(request, env, { error:'Checkout identity could not be stored safely' }, 503);
  }

  return jsonResponse(request, env, {
    id: stripeResult.id,
    url: stripeResult.url,
    stripeMode:stripeConfiguration.mode,
    checkoutRequestId,
    productCodes:lineItems.map(item => item.productCode).filter(Boolean)
  });
}

async function getCheckoutSessionStatus(request, env) {
  const stripeConfiguration = getStripeConfiguration(env);
  if (!stripeConfiguration) {
    return jsonResponse(request, env, { error: 'Checkout is not configured' }, 503);
  }
  if (!getAllowedOrigin(request, env)) {
    return jsonResponse(request, env, { error: 'Origin is not allowed' }, 403);
  }
  const statusRequestUrl = new URL(request.url);
  const sessionId = statusRequestUrl.searchParams.get('session_id') || '';
  const checkoutRequestId = normalizeCheckoutRequestId(statusRequestUrl.searchParams.get('checkout_request_id'));
  const expectedSessionPrefix = stripeConfiguration.mode === 'live' ? 'cs_live_' : 'cs_test_';
  if (!sessionId.startsWith(expectedSessionPrefix) || !/^cs_(?:test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
    return jsonResponse(request, env, { error: 'Checkout session is invalid' }, 400);
  }
  if (!checkoutRequestId) {
    return jsonResponse(request, env, { error: 'Checkout request identity is invalid' }, 400);
  }

  const stripeStatusUrl = new URL(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
  stripeStatusUrl.searchParams.set('expand[]', 'payment_intent');
  const stripeResponse = await fetch(stripeStatusUrl, {
    headers: { Authorization: `Bearer ${stripeConfiguration.secretKey}` }
  });
  const stripeResult = await stripeResponse.json().catch(() => ({}));
  if (!stripeResponse.ok) {
    console.error('Stripe checkout status request failed', {
      status: stripeResponse.status,
      type: stripeResult?.error?.type,
      code: stripeResult?.error?.code
    });
    return jsonResponse(request, env, { error: 'Checkout confirmation could not be verified' }, 502);
  }
  if (stripeResult?.metadata?.checkout_request_id !== checkoutRequestId) {
    return jsonResponse(request, env, { error:'Checkout session does not match this cart' }, 403);
  }

  const paymentIntent = stripeResult?.payment_intent && typeof stripeResult.payment_intent === 'object'
    ? stripeResult.payment_intent
    : null;
  const paymentIntentStatus = cleanText(paymentIntent?.status, '');
  const paymentStatus = cleanText(stripeResult.payment_status, '');
  const sessionStatus = cleanText(stripeResult.status, '');
  const outcome = paymentStatus === 'paid' || paymentStatus === 'no_payment_required'
    ? 'confirmed'
    : sessionStatus === 'expired' || ['canceled', 'requires_payment_method'].includes(paymentIntentStatus)
      ? 'failed'
      : 'processing';

  return jsonResponse(request, env, {
    status:sessionStatus,
    paymentStatus,
    paymentIntentStatus,
    outcome,
    checkoutRequestId,
    orderReference: stripeResult.client_reference_id
      ? `#GF-${stripeResult.client_reference_id}`
      : `#GF-${sessionId.slice(-8).toUpperCase()}`
  });
}

/*
 * =========================================================
 * STRIPE WEBHOOK -> ORDER CONFIRMATION EMAIL (via Resend)
 * =========================================================
 *
 * Fires on checkout.session.completed. Requires these to be configured
 * on the Worker (none of this lives in the repo - see the deploy notes
 * in this file's header comment / the project README):
 *
 *   wrangler secret put STRIPE_LIVE_WEBHOOK_SECRET   (from the Stripe
 *     Dashboard webhook endpoint you create, see below)
 *   wrangler secret put RESEND_API_KEY          (from resend.com)
 *
 * And in wrangler.jsonc `vars` (not secret, just a from-address):
 *   RESEND_FROM_EMAIL  e.g. "Good Frame <orders@goodframe.com.au>"
 *     (the domain in this address must be a verified sender in Resend)
 *
 * Stripe Dashboard setup (Developers -> Webhooks -> Add endpoint):
 *   URL: https://<your-worker-subdomain>.workers.dev/stripe-webhook
 *   Event: checkout.session.completed
 *   Copy the generated "Signing secret" into STRIPE_LIVE_WEBHOOK_SECRET.
 *
 * The email HTML itself is NOT duplicated here - it's fetched at
 * send-time from Checkout/payment-confirmation-email.html on the live
 * site (via SITE_BASE_URL) and its {{tokens}} are filled in below, so
 * editing that one file is enough to change what customers receive.
 */

async function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) {
    return false;
  }

  const parts = Object.fromEntries(
    signatureHeader.split(',').map(pair => {
      const [key, value] = pair.split('=');
      return [key, value];
    })
  );

  const timestamp = parts.t;
  const expectedSignature = parts.v1;
  if (!timestamp || !expectedSignature) {
    return false;
  }

  // Reject stale requests (5 minute tolerance, matches Stripe's own SDKs)
  // to guard against replayed webhook deliveries.
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`)
  );
  const computedSignature = [...new Uint8Array(signatureBuffer)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');

  return timingSafeEqualHex(computedSignature, expectedSignature);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatCurrency(amountInCents, currency) {
  const amount = (Number(amountInCents) || 0) / 100;
  try {
    return new Intl.NumberFormat('en-AU', {
      style: 'currency',
      currency: (currency || 'aud').toUpperCase()
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

async function fetchLineItems(sessionId, env) {
  const stripeConfiguration = getStripeConfiguration(env);
  if (!stripeConfiguration) return [];
  const response = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${sessionId}/line_items?limit=100`,
    { headers: { Authorization: `Bearer ${stripeConfiguration.secretKey}` } }
  );

  if (!response.ok) {
    return [];
  }

  const data = await response.json();
  return Array.isArray(data.data) ? data.data : [];
}

function buildItemLabel(lineItems) {
  const framedItems = lineItems.filter(
    item => !(item.description || '').toLowerCase().includes('shipping')
  );

  if (framedItems.length === 0) {
    return 'Your order';
  }

  const name = framedItems[0].description || 'Print & Frame';
  return framedItems.length === 1
    ? name
    : `${name} + ${framedItems.length - 1} more`;
}

async function sendOrderConfirmationEmail(session, env) {
  if (!env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY is not configured - skipping confirmation email');
    return;
  }

  const customerEmail = session.customer_details?.email || session.customer_email;
  if (!customerEmail) {
    console.error('Checkout session has no customer email - skipping confirmation email');
    return;
  }

  const lineItems = await fetchLineItems(session.id, env);
  const orderNumber = session.client_reference_id
    ? `#GF-${session.client_reference_id}`
    : `#GF-${session.id.slice(-8).toUpperCase()}`;
  const itemName = buildItemLabel(lineItems);
  const totalPaid = formatCurrency(session.amount_total, session.currency);

  const siteBaseUrl = String(env.SITE_BASE_URL || 'https://goodframe.com.au').replace(/\/$/, '');
  const templateResponse = await fetch(`${siteBaseUrl}/Checkout/payment-confirmation-email.html`);
  if (!templateResponse.ok) {
    throw new Error(`Could not load email template (${templateResponse.status})`);
  }

  const supportEmail = env.SUPPORT_EMAIL || 'contact.goodframe@gmail.com';
  const trackOrderUrl = `mailto:${supportEmail}?subject=${encodeURIComponent(`Order tracking — ${orderNumber}`)}`;

  let html = await templateResponse.text();
  html = html
    .replaceAll('{{orderNumber}}', escapeHtml(orderNumber))
    .replaceAll('{{itemName}}', escapeHtml(itemName))
    .replaceAll('{{totalPaid}}', escapeHtml(totalPaid))
    .replaceAll('{{trackOrderUrl}}', trackOrderUrl)
    .replaceAll('{{homeUrl}}', `${siteBaseUrl}/`)
    .replaceAll('{{year}}', String(new Date().getFullYear()));

  const emailResponse = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL || 'Good Frame <orders@goodframe.com.au>',
      to: [customerEmail],
      subject: 'Your Good Frame order is confirmed',
      html
    })
  });

  if (!emailResponse.ok) {
    const errorText = await emailResponse.text();
    throw new Error(`Resend API error (${emailResponse.status}): ${errorText}`);
  }
}

async function claimWebhookEvent(eventId, env) {
  if (!env.ARTWORK_BUCKET || !/^evt_[A-Za-z0-9]+$/.test(String(eventId || ''))) {
    throw new Error('Webhook idempotency storage is not configured');
  }
  const eventKey = `stripe-webhook-events/${eventId}.json`;
  if (await env.ARTWORK_BUCKET.head(eventKey)) {
    return false;
  }
  const result = await env.ARTWORK_BUCKET.put(eventKey, JSON.stringify({
    eventId,
    claimedAt: new Date().toISOString()
  }), {
    httpMetadata: { contentType: 'application/json' },
    onlyIf: { etagDoesNotMatch: '*' }
  });
  return result !== null;
}

async function readR2Json(object) {
  if (!object) return null;
  try {
    if (typeof object.json === 'function') return await object.json();
    if (typeof object.text === 'function') return JSON.parse(await object.text());
    if (object.body) return await new Response(object.body).json();
  } catch {
    return null;
  }
  return null;
}

function getCheckoutUploadSessionIds(session) {
  const metadata = session?.metadata || {};
  const collectChunks = prefix => Object.entries(metadata)
    .filter(([key]) => new RegExp(`^${prefix}(?:_[1-9][0-9]*)?$`).test(key))
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric:true }))
    .flatMap(([, value]) => String(value || '').split(','));
  const values = collectChunks('upload_session_ids');
  const references = values.length ? values : collectChunks('upload_references');
  return [...new Set(references.map(normalizeUploadReference).filter(Boolean))];
}

async function markUploadSessionsCheckoutPending(lineItems, stripeSession, env) {
  if (!env.PRODUCT_CODES_DB) throw new Error('Photo selection storage is not configured');
  const uploadItems = lineItems.filter(item =>
    item.productType === 'tiny_frame_photo_sets' && item.photoCount > 0 && normalizeUploadReference(item.uploadReference)
  );
  if (!uploadItems.length) return 0;
  const stripeSessionId = cleanText(stripeSession?.id, '');
  const expiresAt = Number(stripeSession?.expires_at);
  for (const item of uploadItems) {
    const record = await getPhotoUploadSession(env.PRODUCT_CODES_DB, item.uploadReference);
    if (!record) continue;
    if (!stripeSessionId.startsWith('cs_') || !Number.isSafeInteger(expiresAt)) {
      throw new Error('Stripe checkout session details could not be verified');
    }
    const productCodes = parsePhotoUploadJson(record?.product_codes_json, []);
    if (
      !record || record.cart_item_id !== item.cartItemId ||
      !['finalized', 'checkout_pending', 'paid'].includes(record.status) ||
      !Array.isArray(productCodes) || !productCodes.includes(item.productCode) ||
      !parsePhotoUploadJson(record.snapshot_json, null)
    ) throw new Error('The selected photo snapshot is not ready for checkout');
    if (record.status === 'paid') {
      if (record.stripe_checkout_session_id !== stripeSessionId) {
        throw new Error('The selected photos already belong to another paid order');
      }
      continue;
    }
    if (record.status === 'checkout_pending' && record.stripe_checkout_session_id !== stripeSessionId) {
      throw new Error('The selected photos are already attached to another checkout');
    }
    await env.PRODUCT_CODES_DB.prepare(
      `UPDATE photo_upload_sessions
          SET status = 'checkout_pending',
              stripe_checkout_session_id = ?,
              checkout_expires_at = ?,
              state_version = state_version + 1,
              updated_at = ?
        WHERE upload_session_id = ?
          AND status IN ('finalized', 'checkout_pending')`
    ).bind(
      stripeSessionId,
      new Date(expiresAt * 1000).toISOString(),
      new Date().toISOString(),
      item.uploadReference
    ).run();
  }
}

async function releaseExpiredUploadSessions(stripeSession, env) {
  if (!env.PRODUCT_CODES_DB) return 0;
  const stripeSessionId = cleanText(stripeSession?.id, '');
  if (!stripeSessionId) return 0;
  let released = 0;
  for (const uploadSessionId of getCheckoutUploadSessionIds(stripeSession)) {
    const result = await env.PRODUCT_CODES_DB.prepare(
      `UPDATE photo_upload_sessions
          SET status = 'draft',
              snapshot_json = NULL,
              stripe_checkout_session_id = NULL,
              checkout_expires_at = NULL,
              state_version = state_version + 1,
              updated_at = ?
        WHERE upload_session_id = ?
          AND stripe_checkout_session_id = ?
          AND status = 'checkout_pending'`
    ).bind(new Date().toISOString(), uploadSessionId, stripeSessionId).run();
    released += Number(result?.meta?.changes ?? result?.changes ?? 0);
  }
  return released;
}

function getCheckoutProductCodes(session) {
  const metadata = session?.metadata || {};
  const values = Object.entries(metadata)
    .filter(([key]) => /^product_codes(?:_[1-9][0-9]*)?$/.test(key))
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric:true }))
    .flatMap(([, value]) => String(value || '').split(','))
    .map(normalizeProductCode)
    .filter(Boolean);
  return [...new Set(values)];
}

function getPaidOrderFolder(paidAt, orderCode) {
  const code = normalizeProductCode(orderCode);
  const date = new Date(paidAt);
  if (!code || Number.isNaN(date.getTime())) throw new Error('Paid order folder details are invalid');
  const { year, month, day } = getBrisbaneDateParts(date);
  return `orders/${year}-${month}-${day}_${code}`;
}

async function putPaidPhotoOnce(bucket, finalKey, source, orderCode, productCodes, stripeCheckoutSessionId, paidAt) {
  const sourceMetadata = source.customMetadata || {};
  const requiredMetadata = {
    upload_session_id:String(sourceMetadata.upload_session_id || ''),
    photo_id:String(sourceMetadata.photo_id || ''),
    revision:String(sourceMetadata.revision || ''),
    order_code:orderCode,
    product_codes:productCodes.join(','),
    stripe_checkout_session_id:stripeCheckoutSessionId
  };
  if (!requiredMetadata.upload_session_id || !requiredMetadata.photo_id || !requiredMetadata.revision) {
    throw new Error(`Stored artwork metadata for ${finalKey} is incomplete`);
  }
  const customMetadata = {
    ...sourceMetadata,
    ...requiredMetadata,
    status:'paid',
    paid_at:paidAt
  };
  const stored = await bucket.put(finalKey, source.body, {
    httpMetadata:{ contentType:'image/jpeg' },
    customMetadata,
    onlyIf:{ etagDoesNotMatch:'*' }
  });
  if (stored !== null) return;

  const existing = await bucket.head(finalKey);
  const samePhoto = existing &&
    (!Number.isFinite(Number(source.size)) || Number(existing.size) === Number(source.size)) &&
    Object.entries(requiredMetadata).every(([key, value]) => existing.customMetadata?.[key] === value) &&
    existing.customMetadata?.status === 'paid';
  if (!samePhoto) throw new Error(`Refusing to replace a different paid-order photo at ${finalKey}`);
}

async function putPaidManifestOnce(bucket, manifestKey, manifest) {
  const stored = await bucket.put(manifestKey, JSON.stringify(manifest), {
    httpMetadata:{ contentType:'application/json' },
    onlyIf:{ etagDoesNotMatch:'*' }
  });
  if (stored !== null) return;
  const existing = await readR2Json(await bucket.get(manifestKey));
  const samePhotos = Array.isArray(existing?.photos) && existing.photos.length === manifest.photos.length &&
    existing.photos.every((photo, index) =>
      photo?.position === manifest.photos[index]?.position &&
      photo?.objectKey === manifest.photos[index]?.objectKey
    );
  if (
    existing?.stripe_checkout_session_id !== manifest.stripe_checkout_session_id ||
    existing?.order_code !== manifest.order_code ||
    existing?.status !== 'paid' ||
    !samePhotos
  ) throw new Error(`Refusing to replace a different paid-order manifest at ${manifestKey}`);
}

async function deleteTemporaryUploadObjects(bucket, uploadSessionId, storageFolder) {
  const prefix = getTinyFrameUploadPrefix(uploadSessionId, storageFolder);
  let cursor;
  do {
    const listing = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    await deleteObjectKeys(bucket, listing.objects.map(object => object.key));
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
}

async function markUploadSessionsPaid(session, env) {
  if (!env.ARTWORK_BUCKET) throw new Error('Artwork storage is not configured');
  const uploadSessionIds = getCheckoutUploadSessionIds(session);
  const stripeCheckoutSessionId = cleanText(session?.id, '');
  if (uploadSessionIds.length && !stripeCheckoutSessionId) {
    throw new Error('Paid checkout session ID is missing');
  }
  for (const uploadSessionId of uploadSessionIds) {
    const record = await getPhotoUploadSession(env.PRODUCT_CODES_DB, uploadSessionId);
    const storageFolder = getPhotoUploadStorageFolder(record, uploadSessionId);
    const parsedProductCodes = parsePhotoUploadJson(record?.product_codes_json, []);
    const storedProductCodes = (Array.isArray(parsedProductCodes) ? parsedProductCodes : [])
      .map(normalizeProductCode)
      .filter(Boolean);
    if (record?.status === 'paid' && storedProductCodes.length) {
      const productCode = normalizeProductCode(record.product_code);
      if (productCode && productCode === storedProductCodes[0]) {
        const manifestKey = `${getTinyFrameUploadPrefix(uploadSessionId, storageFolder)}manifest.json`;
        if (!await env.ARTWORK_BUCKET.head(manifestKey)) {
          throw new Error(`Paid product ${productCode} is missing its photo manifest`);
        }
        continue;
      }
      const paidOrderFolder = getPaidOrderFolder(record.updated_at, storedProductCodes[0]);
      if (!await env.ARTWORK_BUCKET.head(`${paidOrderFolder}/manifest.json`)) {
        throw new Error(`Paid order ${storedProductCodes[0]} is missing its photo manifest`);
      }
      try {
        await deleteTemporaryUploadObjects(env.ARTWORK_BUCKET, uploadSessionId, storageFolder);
      } catch (error) {
        console.warn('Paid temporary upload cleanup will be retried later', {
          uploadSessionId,
          errorName:String(error?.name || 'Error')
        });
      }
      continue;
    }
    const currentKey = getUploadManifestKey(uploadSessionId, storageFolder);
    const legacyKey = getLegacyIndividualUploadManifestKey(uploadSessionId);
    let manifestKey = currentKey;
    let object = await env.ARTWORK_BUCKET.get(currentKey);
    if (!object) {
      manifestKey = legacyKey;
      object = await env.ARTWORK_BUCKET.get(legacyKey);
    }
    if (!object) throw new Error(`Upload session ${uploadSessionId} could not be found`);
    const manifest = await readR2Json(object);
    if (!manifest) throw new Error(`Upload session ${uploadSessionId} has an invalid manifest`);
    if (manifest.storage_version === INDIVIDUAL_PHOTO_STORAGE_VERSION) {
      if (!env.PRODUCT_CODES_DB) throw new Error('Photo selection storage is not configured');
      const snapshot = parsePhotoUploadJson(record?.snapshot_json, null);
      const productCodes = storedProductCodes;
      if (
        !record || !snapshot || record.cart_item_id !== snapshot.cart_item_id ||
        !['checkout_pending', 'paid'].includes(record.status) ||
        (record.stripe_checkout_session_id && record.stripe_checkout_session_id !== stripeCheckoutSessionId) ||
        !stripeCheckoutSessionId || !productCodes.length ||
        !Array.isArray(snapshot.photos) || snapshot.photos.length !== Number(snapshot.photo_count)
      ) throw new Error(`Upload session ${uploadSessionId} is missing its verified paid-order snapshot`);
      const paidAt = manifest.paid_at || new Date().toISOString();
      const orderCode = productCodes[0];
      if (normalizeProductCode(record.product_code) === orderCode) {
        const finalPhotos = [];
        for (const [index, photo] of snapshot.photos.entries()) {
          const objectKey = String(photo?.objectKey || '');
          const source = await env.ARTWORK_BUCKET.get(objectKey);
          if (
            !source ||
            !isValidIndividualPhotoKey(objectKey, uploadSessionId, orderCode) ||
            source.customMetadata?.upload_session_id !== uploadSessionId ||
            source.customMetadata?.product_code !== orderCode ||
            source.customMetadata?.photo_id !== photo.photo_id ||
            source.customMetadata?.revision !== photo.revision
          ) throw new Error(`Stored artwork for ${uploadSessionId} could not be found`);
          const position = index + 1;
          await env.ARTWORK_BUCKET.put(objectKey, source.body, {
            httpMetadata:{ contentType:'image/jpeg' },
            customMetadata:{
              ...(source.customMetadata || {}),
              order_code:orderCode,
              product_codes:productCodes.join(','),
              stripe_checkout_session_id:stripeCheckoutSessionId,
              status:'paid',
              paid_at:paidAt
            }
          });
          finalPhotos.push({
            photo_id:photo.photo_id,
            revision:photo.revision,
            position,
            objectKey,
            contentType:'image/jpeg'
          });
        }
        await env.ARTWORK_BUCKET.put(manifestKey, JSON.stringify({
          ...manifest,
          ...snapshot,
          order_code:orderCode,
          product_codes:productCodes,
          stripe_checkout_session_id:stripeCheckoutSessionId,
          photos:finalPhotos,
          files:finalPhotos,
          status:'paid',
          paid_at:paidAt
        }), { httpMetadata:{ contentType:'application/json' } });
        await env.PRODUCT_CODES_DB.prepare(
          `UPDATE photo_upload_sessions
              SET status = 'paid',
                  state_version = state_version + 1,
                  updated_at = ?
            WHERE upload_session_id = ?
              AND stripe_checkout_session_id = ?
              AND status IN ('checkout_pending', 'paid')`
        ).bind(paidAt, uploadSessionId, stripeCheckoutSessionId).run();
        continue;
      }
      const paidOrderFolder = getPaidOrderFolder(paidAt, orderCode);
      const finalPhotos = [];
      for (const [index, photo] of snapshot.photos.entries()) {
        const sourceKey = String(photo?.objectKey || '');
        const source = await env.ARTWORK_BUCKET.get(sourceKey);
        if (
          !source || !isValidIndividualPhotoKey(sourceKey, uploadSessionId, storageFolder) ||
          source.customMetadata?.upload_session_id !== uploadSessionId ||
          source.customMetadata?.photo_id !== photo.photo_id ||
          source.customMetadata?.revision !== photo.revision
        ) throw new Error(`Stored artwork for ${uploadSessionId} could not be found`);
        const position = index + 1;
        const finalKey = `${paidOrderFolder}/photo-${String(position).padStart(2, '0')}.jpg`;
        await putPaidPhotoOnce(
          env.ARTWORK_BUCKET,
          finalKey,
          source,
          orderCode,
          productCodes,
          stripeCheckoutSessionId,
          paidAt
        );
        finalPhotos.push({
          photo_id:photo.photo_id,
          revision:photo.revision,
          position,
          objectKey:finalKey,
          contentType:'image/jpeg'
        });
      }
      const finalManifestKey = `${paidOrderFolder}/manifest.json`;
      await putPaidManifestOnce(env.ARTWORK_BUCKET, finalManifestKey, {
        storage_version:INDIVIDUAL_PHOTO_STORAGE_VERSION,
        stripe_checkout_session_id:stripeCheckoutSessionId,
        order_code:orderCode,
        product_codes:productCodes,
        cart_item_id:snapshot.cart_item_id,
        frame_colour:snapshot.frame_colour,
        product_type:snapshot.product_type,
        photo_set_count:snapshot.photo_set_count,
        photo_count:snapshot.photo_count,
        selected_photo_order:finalPhotos.map(photo => photo.photo_id),
        photos:finalPhotos,
        status:'paid',
        paid_at:paidAt
      });
      await env.PRODUCT_CODES_DB.prepare(
        `UPDATE photo_upload_sessions
            SET status = 'paid',
                state_version = state_version + 1,
                updated_at = ?
          WHERE upload_session_id = ?
            AND stripe_checkout_session_id = ?
            AND status IN ('checkout_pending', 'paid')`
      ).bind(paidAt, uploadSessionId, stripeCheckoutSessionId).run();
      try {
        await deleteTemporaryUploadObjects(env.ARTWORK_BUCKET, uploadSessionId, storageFolder);
      } catch (error) {
        console.warn('Paid temporary upload cleanup will be retried later', {
          uploadSessionId,
          errorName:String(error?.name || 'Error')
        });
      }
      continue;
    }
    if (manifest.storage_version === LEGACY_INDIVIDUAL_PHOTO_STORAGE_VERSION) {
      if (
        manifest.status === 'paid' &&
        manifest.stripe_checkout_session_id !== stripeCheckoutSessionId
      ) throw new Error(`Upload session ${uploadSessionId} already belongs to another paid order`);
      const productCodes = (Array.isArray(manifest.product_codes) ? manifest.product_codes : []).map(normalizeProductCode).filter(Boolean);
      const photos = Array.isArray(manifest.photos) ? manifest.photos : [];
      if (!stripeCheckoutSessionId || !productCodes.length || !photos.length) {
        throw new Error(`Upload session ${uploadSessionId} is missing paid-order relationships`);
      }
      const paidAt = manifest.paid_at || new Date().toISOString();
      const orderCode = productCodes[0];
      const paidOrderFolder = getPaidOrderFolder(paidAt, orderCode);
      const finalPhotos = [];
      for (const [index, photo] of photos.entries()) {
        const sourceKey = String(photo?.objectKey || '');
        const source = await env.ARTWORK_BUCKET.get(sourceKey);
        if (!source || !isValidIndividualPhotoKey(sourceKey, uploadSessionId)) {
          throw new Error(`Stored artwork for ${uploadSessionId} could not be found`);
        }
        const position = index + 1;
        const finalKey = `${paidOrderFolder}/photo-${String(position).padStart(2, '0')}.jpg`;
        await putPaidPhotoOnce(
          env.ARTWORK_BUCKET,
          finalKey,
          source,
          orderCode,
          productCodes,
          stripeCheckoutSessionId,
          paidAt
        );
        finalPhotos.push({ position, objectKey:finalKey, contentType:'image/jpeg' });
      }
      const finalManifestKey = `${paidOrderFolder}/manifest.json`;
      await putPaidManifestOnce(env.ARTWORK_BUCKET, finalManifestKey, {
        storage_version:INDIVIDUAL_PHOTO_STORAGE_VERSION,
        stripe_checkout_session_id:stripeCheckoutSessionId,
        order_code:orderCode,
        product_codes:productCodes,
        cart_item_id:manifest.cart_item_id,
        frame_colour:manifest.frame_colour,
        product_type:manifest.product_type,
        photo_count:manifest.photo_count,
        photo_set_count:manifest.photo_set_count,
        photos:finalPhotos,
        status:'paid',
        paid_at:paidAt
      });
      await env.ARTWORK_BUCKET.put(manifestKey, JSON.stringify({
        ...manifest,
        status:'paid',
        stripe_checkout_session_id:stripeCheckoutSessionId,
        paid_at:paidAt,
        final_order:{ order_code:orderCode, manifest_key:finalManifestKey, photos:finalPhotos }
      }), { httpMetadata:{ contentType:'application/json' } });
      continue;
    }
    if (manifest.status === 'paid') {
      if (manifest.stripe_checkout_session_id !== stripeCheckoutSessionId) {
        throw new Error(`Upload session ${uploadSessionId} already belongs to another paid order`);
      }
      continue;
    }
    const paidAt = new Date().toISOString();
    const relatedFiles = [
      ...(Array.isArray(manifest.processed_images) ? manifest.processed_images : []),
      ...(Array.isArray(manifest.originals) ? manifest.originals : [])
    ];
    for (const file of relatedFiles) {
      const objectKey = String(file?.objectKey || '');
      if (!objectKey.startsWith(getTinyFrameUploadPrefix(uploadSessionId))) continue;
      const storedObject = await env.ARTWORK_BUCKET.get(objectKey);
      if (!storedObject) throw new Error(`Stored artwork for ${uploadSessionId} could not be found`);
      await env.ARTWORK_BUCKET.put(objectKey, storedObject.body, {
        httpMetadata:{ contentType:String(file.contentType || 'application/octet-stream') },
        customMetadata:{
          ...(storedObject.customMetadata || {}),
          status:'paid',
          paid_at:paidAt,
          ...(stripeCheckoutSessionId ? { stripe_checkout_session_id:stripeCheckoutSessionId } : {})
        }
      });
    }
    await env.ARTWORK_BUCKET.put(manifestKey, JSON.stringify({
      ...manifest,
      status:'paid',
      ...(stripeCheckoutSessionId ? { stripe_checkout_session_id:stripeCheckoutSessionId } : {}),
      paid_at:paidAt
    }), {
      httpMetadata: { contentType:'application/json' }
    });
  }
  return uploadSessionIds.length;
}

async function cleanupPendingUploads(env, now = Date.now()) {
  if (!env.ARTWORK_BUCKET) throw new Error('Artwork storage is not configured');
  const configuredDays = Number(env.PENDING_UPLOAD_TTL_DAYS);
  const ttlDays = Number.isFinite(configuredDays) && configuredDays === 7
    ? configuredDays
    : DEFAULT_PENDING_UPLOAD_TTL_DAYS;
  const cutoff = now - (ttlDays * 24 * 60 * 60 * 1000);
  const cutoffIso = new Date(cutoff).toISOString();
  let deletedSessions = 0;
  if (env.PRODUCT_CODES_DB) {
    const stale = await env.PRODUCT_CODES_DB.prepare(
      `SELECT upload_session_id, status, stripe_checkout_session_id, checkout_expires_at,
              updated_at, storage_folder, product_code
         FROM photo_upload_sessions
        WHERE status IN ('draft', 'finalized', 'checkout_pending', 'expired')
          AND updated_at < ?`
    ).bind(cutoffIso).all();
    for (const record of stale.results || []) {
      let safeToDelete = ['draft', 'finalized', 'expired'].includes(record.status);
      if (record.status === 'checkout_pending') {
        const expiresAt = Date.parse(record.checkout_expires_at || '');
        const stripeConfiguration = getStripeConfiguration(env);
        if (
          !stripeConfiguration || !record.stripe_checkout_session_id ||
          !Number.isFinite(expiresAt) || expiresAt > now
        ) continue;
        let stripeSession;
        try {
          stripeSession = await retrieveStripeSession(stripeConfiguration, record.stripe_checkout_session_id);
          if (stripeSession.status === 'open') {
            stripeSession = await expireStripeSession(stripeConfiguration, record.stripe_checkout_session_id);
          }
        } catch {
          continue;
        }
        safeToDelete = stripeSession.status === 'expired';
      }
      if (!safeToDelete) continue;
      const claim = await env.PRODUCT_CODES_DB.prepare(
        `UPDATE photo_upload_sessions
            SET status = 'expired',
                snapshot_json = NULL,
                state_version = state_version + 1
          WHERE upload_session_id = ?
            AND status = ?
            AND updated_at < ?`
      ).bind(record.upload_session_id, record.status, cutoffIso).run();
      if (Number(claim?.meta?.changes ?? claim?.changes ?? 0) !== 1) continue;
      const prefix = getTinyFrameUploadPrefix(
        record.upload_session_id,
        getPhotoUploadStorageFolder(record, record.upload_session_id)
      );
      let sessionCursor;
      do {
        const sessionObjects = await env.ARTWORK_BUCKET.list({
          prefix,
          ...(sessionCursor ? { cursor:sessionCursor } : {})
        });
        await deleteObjectKeys(env.ARTWORK_BUCKET, sessionObjects.objects.map(item => item.key));
        sessionCursor = sessionObjects.truncated ? sessionObjects.cursor : undefined;
      } while (sessionCursor);
      deletedSessions += 1;
    }
  }
  for (const uploadPrefix of [TINY_FRAME_UPLOAD_PREFIX, LEGACY_TINY_FRAME_UPLOAD_PREFIX]) {
    let cursor;
    do {
      const listing = await env.ARTWORK_BUCKET.list({
        prefix:uploadPrefix,
        ...(cursor ? { cursor } : {})
      });
      const manifests = listing.objects.filter(object => object.key.endsWith('/manifest.json'));
      for (const listedManifest of manifests) {
        const object = await env.ARTWORK_BUCKET.get(listedManifest.key);
        const manifest = await readR2Json(object);
        if (Number(manifest?.storage_version) === INDIVIDUAL_PHOTO_STORAGE_VERSION) continue;
        const uploadedAt = Date.parse(manifest?.uploaded_at || '');
        if (!manifest || !['draft', 'finalized', 'pending'].includes(manifest.status) || !Number.isFinite(uploadedAt) || uploadedAt >= cutoff) continue;
        const uploadSessionId = normalizeUploadReference(manifest.upload_session_id);
        if (!uploadSessionId) continue;
        const prefix = listedManifest.key.startsWith(TINY_FRAME_UPLOAD_PREFIX)
          ? getTinyFrameUploadPrefix(uploadSessionId)
          : `${LEGACY_TINY_FRAME_UPLOAD_PREFIX}${uploadSessionId}/`;
        const storedFileKeys = Array.isArray(manifest.files)
          ? manifest.files.map(file => String(file?.objectKey || '')).filter(key => key.startsWith(prefix))
          : [];
        let sessionCursor;
        do {
          const sessionObjects = await env.ARTWORK_BUCKET.list({ prefix, ...(sessionCursor ? { cursor:sessionCursor } : {}) });
          await deleteObjectKeys(env.ARTWORK_BUCKET, sessionObjects.objects.map(item => item.key));
          sessionCursor = sessionObjects.truncated ? sessionObjects.cursor : undefined;
        } while (sessionCursor);
        await deleteObjectKeys(env.ARTWORK_BUCKET, [...new Set([...storedFileKeys, listedManifest.key])]);
        deletedSessions += 1;
      }
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor);
  }

  return deletedSessions;
}

async function handleStripeWebhook(request, env) {
  const stripeConfiguration = getStripeConfiguration(env);
  if (!stripeConfiguration?.webhookSecret) {
    return new Response('Webhook secret is not configured', { status: 500 });
  }

  const rawBody = await request.text();
  const isValid = await verifyStripeSignature(
    rawBody,
    request.headers.get('Stripe-Signature'),
    stripeConfiguration.webhookSecret
  );

  if (!isValid) {
    return new Response('Invalid signature', { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response('Invalid JSON payload', { status: 400 });
  }

  const eventIsLive = event.livemode === true;
  if (eventIsLive !== (stripeConfiguration.mode === 'live')) {
    return new Response('Stripe event mode does not match this environment', { status: 400 });
  }

  // Test payments are deliberately side-effect free: do not promote uploads
  // to paid, claim production fulfilment events, or send customer emails.
  if (stripeConfiguration.mode === 'test') {
    return new Response(JSON.stringify({
      received:true,
      testMode:true,
      fulfilmentSuppressed:true
    }), {
      status:200,
      headers: { 'Content-Type':'application/json' }
    });
  }

  if (event.type === 'checkout.session.expired') {
    try {
      await releaseExpiredUploadSessions(event.data.object, env);
    } catch (error) {
      console.error('Expired checkout photo selection could not be released:', error);
      return new Response('Expired checkout photos could not be released', { status:503 });
    }
  }

  const completedSession = event.data?.object;
  if (
    ['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type) &&
    completedSession?.payment_status === 'paid'
  ) {
    try {
      await markProductCodesPaid(env.PRODUCT_CODES_DB, completedSession);
      await markUploadSessionsPaid(completedSession, env);
    } catch (error) {
      console.error('Paid product relationship update failed:', error);
      return new Response('Paid product relationships could not be updated', { status: 503 });
    }
    let claimed;
    try {
      claimed = await claimWebhookEvent(event.id, env);
    } catch (error) {
      console.error('Webhook idempotency claim failed:', error);
      return new Response('Webhook idempotency storage is unavailable', { status: 503 });
    }
    if (!claimed) {
      return new Response(JSON.stringify({ received:true, duplicate:true }), {
        status:200,
        headers: { 'Content-Type':'application/json' }
      });
    }
    try {
      await sendOrderConfirmationEmail(completedSession, env);
    } catch (error) {
      // The payment already succeeded regardless of whether the email
      // goes out, so log and still acknowledge the webhook - returning
      // an error here would just make Stripe retry a delivery that will
      // fail the same way again (e.g. a bad API key), risking duplicate
      // emails on the deliveries that *do* succeed partway through.
      console.error('Order confirmation email failed:', error);
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function isAuthorizedAdminRequest(request, env) {
  const configuredKey = String(env.ADMIN_API_KEY || '');
  const suppliedKey = String(request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  return configuredKey.length >= 24 && suppliedKey === configuredKey;
}

async function getProductCodeRecord(request, env, productCode) {
  if (!env.PRODUCT_CODES_DB || !env.ADMIN_API_KEY) {
    return jsonResponse(request, env, { error:'Order management is not configured' }, 503);
  }
  if (!isAuthorizedAdminRequest(request, env)) {
    return jsonResponse(request, env, { error:'Unauthorized' }, 401);
  }
  try {
    const record = await findProductCode(env.PRODUCT_CODES_DB, productCode);
    if (!record) return jsonResponse(request, env, { error:'Product code was not found' }, 404);
    return jsonResponse(request, env, {
      productCode:record.code,
      status:record.status,
      productType:record.product_type,
      frameColour:record.frame_colour,
      unitAmount:record.unit_amount,
      currency:record.currency,
      cartItemId:record.cart_item_id,
      unitIndex:record.unit_index,
      uploadSessionId:record.upload_session_id,
      checkoutRequestId:record.checkout_request_id,
      stripeCheckoutSessionId:record.stripe_checkout_session_id,
      stripePaymentIntentId:record.stripe_payment_intent_id,
      createdAt:record.created_at,
      paidAt:record.paid_at
    });
  } catch (error) {
    return jsonResponse(request, env, { error:error.message }, 400);
  }
}

async function findPaidPhotoManifest(env, record, productCode) {
  const uploadSessionId = normalizeUploadReference(record?.upload_session_id);
  if (uploadSessionId) {
    const uploadRecord = await getPhotoUploadSession(env.PRODUCT_CODES_DB, uploadSessionId);
    const parsedProductCodes = parsePhotoUploadJson(uploadRecord?.product_codes_json, []);
    const productCodes = (Array.isArray(parsedProductCodes) ? parsedProductCodes : [])
      .map(normalizeProductCode)
      .filter(Boolean);
    if (uploadRecord?.status === 'paid' && productCodes.includes(productCode)) {
      if (normalizeProductCode(uploadRecord.product_code) === productCode) {
        const storageFolder = getPhotoUploadStorageFolder(uploadRecord, uploadSessionId);
        const prefix = `${getTinyFrameUploadPrefix(uploadSessionId, storageFolder)}`;
        const object = await env.ARTWORK_BUCKET.get(`${prefix}manifest.json`);
        const manifest = object ? await readR2Json(object) : null;
        if (manifest) return { manifest, prefix };
      }
      const prefix = `${getPaidOrderFolder(uploadRecord.updated_at, productCodes[0])}/`;
      const object = await env.ARTWORK_BUCKET.get(`${prefix}manifest.json`);
      const manifest = object ? await readR2Json(object) : null;
      if (manifest) return { manifest, prefix };
    }
  }
  if (record?.paid_at) {
    const prefix = `${getPaidOrderFolder(record.paid_at, productCode)}/`;
    const object = await env.ARTWORK_BUCKET.get(`${prefix}manifest.json`);
    const manifest = object ? await readR2Json(object) : null;
    if (manifest) return { manifest, prefix };
  }
  const checkoutSessionId = cleanText(record?.stripe_checkout_session_id, '');
  if (!checkoutSessionId) return { manifest:null, prefix:'' };
  for (const folder of [productCode, `product-${productCode}`]) {
    const prefix = `orders/${checkoutSessionId}/${folder}/`;
    const object = await env.ARTWORK_BUCKET.get(`${prefix}manifest.json`);
    const manifest = object ? await readR2Json(object) : null;
    if (manifest) return { manifest, prefix };
  }
  return { manifest:null, prefix:'' };
}

async function getAdminProductAssets(request, env, productCode) {
  if (!env.PRODUCT_CODES_DB || !env.ARTWORK_BUCKET || !env.ADMIN_API_KEY) {
    return jsonResponse(request, env, { error:'Order management is not configured' }, 503);
  }
  if (!isAuthorizedAdminRequest(request, env)) {
    return jsonResponse(request, env, { error:'Unauthorized' }, 401);
  }
  const normalizedCode = normalizeProductCode(productCode);
  if (!normalizedCode) return jsonResponse(request, env, { error:'Product code is invalid' }, 400);
  try {
    const record = await findProductCode(env.PRODUCT_CODES_DB, normalizedCode);
    if (!record) return jsonResponse(request, env, { error:'Product code was not found' }, 404);
    const { manifest, prefix } = await findPaidPhotoManifest(env, record, normalizedCode);
    if ([LEGACY_INDIVIDUAL_PHOTO_STORAGE_VERSION, INDIVIDUAL_PHOTO_STORAGE_VERSION].includes(Number(manifest?.storage_version))) {
        const photos = (Array.isArray(manifest.photos) ? manifest.photos : []).map((photo, index) => ({
          position:Number(photo.position || index + 1),
          filename:`photo-${String(photo.position || index + 1).padStart(2, '0')}.jpg`,
          downloadUrl:`/admin/product-assets/${normalizedCode}/photo/${Number(photo.position || index + 1)}`
        }));
        return jsonResponse(request, env, {
          productCode:normalizedCode,
          status:record.status,
          orderFolder:prefix.replace(/\/$/, ''),
          frameColour:manifest.frame_colour || record.frame_colour,
          photoSetCount:Number(manifest.photo_set_count || 0),
          photoCount:photos.length,
          photos,
          legacyPdf:null
        });
    }
    for (const objectKey of getProductPdfKeyCandidates(normalizedCode)) {
      if (await env.ARTWORK_BUCKET.head(objectKey)) {
        return jsonResponse(request, env, {
          productCode:normalizedCode,
          status:record.status,
          frameColour:record.frame_colour,
          photoCount:record.product_type === 'tiny_frame_8_pictures' ? 8 : 0,
          photos:[],
          legacyPdf:{
            filename:`${normalizedCode}-print-sheet.pdf`,
            downloadUrl:`/admin/product-assets/${normalizedCode}/legacy-pdf`
          }
        });
      }
    }
    return jsonResponse(request, env, {
      productCode:normalizedCode,
      status:record.status,
      frameColour:record.frame_colour,
      photoCount:0,
      photos:[],
      legacyPdf:null
    });
  } catch (error) {
    return jsonResponse(request, env, { error:error.message || 'Product assets could not be loaded' }, 400);
  }
}

async function downloadAdminProductAsset(request, env, productCode, assetType, position = '') {
  if (!env.PRODUCT_CODES_DB || !env.ARTWORK_BUCKET || !env.ADMIN_API_KEY) {
    return jsonResponse(request, env, { error:'Order management is not configured' }, 503);
  }
  if (!isAuthorizedAdminRequest(request, env)) {
    return jsonResponse(request, env, { error:'Unauthorized' }, 401);
  }
  const normalizedCode = normalizeProductCode(productCode);
  if (!normalizedCode) return jsonResponse(request, env, { error:'Product code is invalid' }, 400);
  const record = await findProductCode(env.PRODUCT_CODES_DB, normalizedCode);
  if (!record) return jsonResponse(request, env, { error:'Product code was not found' }, 404);
  let objectKey = '';
  let contentType = 'application/octet-stream';
  let filename = '';
  if (assetType === 'photo') {
    const photoPosition = Number(position);
    if (!Number.isSafeInteger(photoPosition) || photoPosition < 1) {
      return jsonResponse(request, env, { error:'Photo reference is invalid' }, 400);
    }
    const { manifest, prefix:expectedPrefix } = await findPaidPhotoManifest(env, record, normalizedCode);
    const photo = Array.isArray(manifest?.photos) ? manifest.photos.find(item => Number(item?.position) === photoPosition) : null;
    if (!photo || !String(photo.objectKey || '').startsWith(expectedPrefix)) {
      return jsonResponse(request, env, { error:'Photo was not found' }, 404);
    }
    objectKey = String(photo.objectKey);
    contentType = 'image/jpeg';
    filename = `photo-${String(photoPosition).padStart(2, '0')}.jpg`;
  } else if (assetType === 'legacy-pdf') {
    for (const candidate of getProductPdfKeyCandidates(normalizedCode)) {
      if (await env.ARTWORK_BUCKET.head(candidate)) {
        objectKey = candidate;
        break;
      }
    }
    contentType = 'application/pdf';
    filename = `${normalizedCode}-print-sheet.pdf`;
  }
  if (!objectKey) return jsonResponse(request, env, { error:'Product file was not found' }, 404);
  const object = await env.ARTWORK_BUCKET.get(objectKey);
  if (!object) return jsonResponse(request, env, { error:'Product file was not found' }, 404);
  return new Response(object.body, {
    headers:{
      'Content-Type':contentType,
      'Content-Disposition':`attachment; filename="${filename}"`,
      'Cache-Control':'private, no-store',
      'X-Content-Type-Options':'nosniff'
    }
  });
}

async function getProductCodeCapacityRecord(request, env) {
  if (!env.PRODUCT_CODES_DB || !env.ADMIN_API_KEY) {
    return jsonResponse(request, env, { error:'Order management is not configured' }, 503);
  }
  if (!isAuthorizedAdminRequest(request, env)) {
    return jsonResponse(request, env, { error:'Unauthorized' }, 401);
  }
  return jsonResponse(request, env, await getProductCodeCapacity(env.PRODUCT_CODES_DB));
}

async function retrieveShippingQuote(env, stripeConfiguration, shippingCountry) {
  if (shippingCountry === 'AU') {
    return { amount:SHIPPING_AMOUNT, currency:'aud', displayName:'Shipping', rateId:null };
  }
  const rateId = getInternationalShippingRateId(env, stripeConfiguration.mode);
  if (!rateId) throw new Error('International shipping is not configured');
  const response = await fetch(`https://api.stripe.com/v1/shipping_rates/${encodeURIComponent(rateId)}`, {
    headers:{ Authorization:`Bearer ${stripeConfiguration.secretKey}` }
  });
  const rate = await response.json();
  if (
    !response.ok || rate?.id !== rateId || rate?.active !== true ||
    rate?.livemode !== (stripeConfiguration.mode === 'live') ||
    rate?.type !== 'fixed_amount' || rate?.fixed_amount?.currency !== 'aud' ||
    !Number.isInteger(rate?.fixed_amount?.amount)
  ) {
    throw new Error('International shipping rate is unavailable');
  }
  return {
    amount:rate.fixed_amount.amount,
    currency:rate.fixed_amount.currency,
    displayName:String(rate.display_name || 'International shipping'),
    rateId
  };
}

async function getShippingQuote(request, env) {
  if (!getAllowedOrigin(request, env)) {
    return jsonResponse(request, env, { error:'Origin is not allowed' }, 403);
  }
  const stripeConfiguration = getStripeConfiguration(env);
  if (!stripeConfiguration) {
    return jsonResponse(request, env, { error:'Checkout is not configured' }, 503);
  }
  const url = new URL(request.url);
  const requestedCountry = url.searchParams.get('country');
  const detectedCountry = normalizeShippingCountry(request.cf?.country, 'AU') || 'AU';
  const shippingCountry = normalizeShippingCountry(requestedCountry, detectedCountry);
  if (!shippingCountry) {
    return jsonResponse(request, env, { error:'Shipping country is not supported' }, 400);
  }
  try {
    const quote = await retrieveShippingQuote(env, stripeConfiguration, shippingCountry);
    return jsonResponse(request, env, {
      shippingCountry,
      detectedCountry,
      supportedCountries:STRIPE_SHIPPING_COUNTRIES,
      ...quote
    });
  } catch (error) {
    console.error('Stripe shipping-rate lookup failed', { message:error.message });
    return jsonResponse(request, env, { error:error.message }, 503);
  }
}

export {
  buildLineItems,
  claimWebhookEvent,
  cleanupPendingUploads,
  createStripePayload,
  markUploadSessionsPaid,
  normalizeShippingCountry,
  normalizeTinyFrameProductType,
  normalizeUploadReference
};

async function routeWorkerRequest(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      const origin = getAllowedOrigin(request, env);
      const requestedMethod = String(request.headers.get('Access-Control-Request-Method') || '').toUpperCase();
      const requestedHeaders = String(request.headers.get('Access-Control-Request-Headers') || '')
        .split(',')
        .map(header => header.trim().toLowerCase())
        .filter(Boolean);
      if (
        !origin ||
        (requestedMethod && !CORS_ALLOWED_METHODS.includes(requestedMethod)) ||
        requestedHeaders.some(header => !CORS_ALLOWED_HEADERS.includes(header))
      ) {
        return jsonResponse(request, env, { error:'CORS request is not allowed' }, 403);
      }
      return new Response(null, {
        status: 204,
        headers: createCorsHeaders(request, env)
      });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      const stripeConfiguration = getStripeConfiguration(env);
      return jsonResponse(request, env, {
        ok:true,
        stripeMode:getStripeMode(env) || 'invalid',
        checkoutConfigured:Boolean(stripeConfiguration),
        fulfilmentEnabled:Boolean(stripeConfiguration?.fulfilmentEnabled),
        productIdentificationConfigured:Boolean(env.PRODUCT_CODES_DB)
      });
    }

    if (request.method === 'GET' && url.pathname === '/shipping-quote') {
      return getShippingQuote(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/admin/product-code-capacity') {
      return getProductCodeCapacityRecord(request, env);
    }

    const adminAssetMatch = url.pathname.match(/^\/admin\/product-assets\/(\d{5})(?:\/(photo)\/(\d+)|\/(legacy-pdf))?$/);
    if (request.method === 'GET' && adminAssetMatch) {
      if (!adminAssetMatch[2] && !adminAssetMatch[4]) return getAdminProductAssets(request, env, adminAssetMatch[1]);
      return downloadAdminProductAsset(
        request,
        env,
        adminAssetMatch[1],
        adminAssetMatch[4] || adminAssetMatch[2],
        adminAssetMatch[3]
      );
    }

    if (request.method === 'GET' && url.pathname.startsWith('/admin/product-code/')) {
      return getProductCodeRecord(request, env, decodeURIComponent(url.pathname.slice('/admin/product-code/'.length)));
    }

    if (request.method === 'POST' && url.pathname === '/create-checkout-session') {
      return createCheckoutSession(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/tiny-frame-upload/session') {
      return createIndividualUploadSession(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/tiny-frame-upload/selection') {
      return updateIndividualPhotoSelection(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/tiny-frame-upload/photo') {
      return uploadIndividualTinyFramePhoto(request, env);
    }

    if (request.method === 'DELETE' && url.pathname === '/tiny-frame-upload/photo') {
      return deleteIndividualTinyFramePhoto(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/tiny-frame-upload/finalize') {
      return finalizeIndividualTinyFrameUpload(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/tiny-frame-upload/status') {
      return getIndividualTinyFrameUploadStatus(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/checkout-session-status') {
      return getCheckoutSessionStatus(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/artwork/upload') {
      return uploadArtwork(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/artwork/manifest') {
      return createArtworkManifest(request, env);
    }

    if (request.method === 'GET' && url.pathname.startsWith('/artwork/')) {
      try {
        const objectKey = url.pathname.slice('/artwork/'.length).split('/').map(decodeURIComponent).join('/');
        return getArtwork(request, env, objectKey);
      } catch {
        return new Response('Not found', { status: 404 });
      }
    }

    if (request.method === 'POST' && url.pathname === '/stripe-webhook') {
      return handleStripeWebhook(request, env);
    }

    return jsonResponse(request, env, { error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return await routeWorkerRequest(request, env);
    } catch (error) {
      const url = new URL(request.url);
      console.error('Unhandled Worker request error', {
        method:request.method,
        path:url.pathname,
        errorName:String(error?.name || 'Error'),
        message:String(error?.message || 'Unknown Worker error')
      });
      return jsonResponse(request, env, {
        error:'The request could not be completed. Please retry.',
        code:'WORKER_REQUEST_FAILED'
      }, 500);
    }
  },

  async scheduled(controller, env, context) {
    context.waitUntil(cleanupPendingUploads(env, controller.scheduledTime || Date.now()));
  }
};
