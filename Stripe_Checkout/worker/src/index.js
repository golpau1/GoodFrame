import {
  createOriginalObjectKey,
  createThumbnailObjectKey,
  isValidArtworkObjectKey,
  sanitizeUploadId
} from './r2-keys.js';
import {
  PRINT_SHEET_SPECIFICATION,
  createA4PrintSheetPdf,
  getA4PrintLayout,
  readJpegDimensions
} from './print-sheet-pdf.js';
import {
  ProductCodeCapacityError,
  ProductCodeError,
  attachProductPdf,
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
// Keep the multipart request safely below Cloudflare's 100 MB request limit.
const MAX_TINY_FRAME_PDF_BYTES = 95 * 1024 * 1024;
// Larger, already-generated PDFs are transferred to R2 in uniform 8 MiB parts.
// This is a guardrail rather than an encoding limit: the A4 PDF bytes are not changed.
const MAX_TINY_FRAME_MULTIPART_PDF_BYTES = 512 * 1024 * 1024;
const TINY_FRAME_PDF_PART_BYTES = 8 * 1024 * 1024;
const MAX_TINY_FRAME_PDF_PARTS = Math.ceil(MAX_TINY_FRAME_MULTIPART_PDF_BYTES / TINY_FRAME_PDF_PART_BYTES);
const CORS_ALLOWED_METHODS = Object.freeze(['GET', 'POST', 'DELETE', 'OPTIONS']);
const CORS_ALLOWED_HEADERS = Object.freeze(['content-type', 'authorization', 'x-upload-token', 'x-upload-attempt']);
const A4_WIDTH_POINTS = 595.275591;
const A4_HEIGHT_POINTS = 841.889764;
const TINY_FRAME_PHOTO_WIDTH_POINTS = 54 * 72 / 25.4;
const TINY_FRAME_PHOTO_HEIGHT_POINTS = 86 * 72 / 25.4;
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
    'Content-Type': 'application/json'
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

function createUploadSessionId() {
  return `tf_${crypto.randomUUID().replaceAll('-', '')}`;
}

function formatBrisbaneUploadFolder(value = new Date(), suffix = '') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-AU', {
    timeZone:'Australia/Brisbane',
    day:'2-digit',
    month:'2-digit',
    year:'numeric',
    hour:'numeric',
    minute:'2-digit',
    hour12:true
  }).formatToParts(value).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const uniqueSuffix = String(suffix || '').trim().toLowerCase();
  if (uniqueSuffix && !/^[a-f0-9]{4}$/.test(uniqueSuffix)) throw new Error('Upload folder suffix must be four hexadecimal characters');
  return `${parts.day}-${parts.month}-${parts.year}_${Number(parts.hour)}-${parts.minute}${String(parts.dayPeriod || '').toUpperCase()}${uniqueSuffix ? `-${uniqueSuffix}` : ''}`;
}

function normalizeUploadStorageFolder(value) {
  const folder = String(value || '').trim();
  return /^(?:\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[a-f0-9]{4}|\d{2}-\d{2}-\d{4}_(?:[1-9]|1[0-2])-\d{2}(?:AM|PM)(?:-[a-f0-9]{4})?)$/.test(folder)
    ? folder
    : '';
}

function getPhotoUploadStorageFolder(record, uploadSessionId = record?.upload_session_id) {
  return normalizeUploadStorageFolder(record?.storage_folder) || normalizeUploadReference(uploadSessionId);
}

function getTinyFrameUploadPrefix(uploadSessionId, storageFolder = '') {
  const folder = normalizeUploadStorageFolder(storageFolder) || normalizeUploadReference(uploadSessionId);
  return folder ? `${TINY_FRAME_UPLOAD_PREFIX}${folder}/` : '';
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

function getTemporaryPhotoKey(uploadSessionId, storageFolder = '') {
  const sessionId = normalizeUploadReference(uploadSessionId);
  return sessionId
    ? `${getTinyFrameUploadPrefix(sessionId, storageFolder)}photos/${crypto.randomUUID().replaceAll('-', '')}.jpg`
    : '';
}

function isValidIndividualPhotoKey(value, uploadSessionId = '', storageFolder = '') {
  const key = String(value || '');
  const temporary = key.match(/^temporary\/([^/]+)\/photos\/[a-f0-9]{32}\.jpg$/);
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

function isValidTinyFramePrintSheetKey(value) {
  return /^tinyframes\/tf_[a-f0-9]{32}\/print-sheet-(?:a4|[1-9][0-9]{4})\.pdf$/.test(String(value || ''));
}

function getProductPdfKey(productCode) {
  const code = normalizeProductCode(productCode);
  return code ? `${code}/${code}-print-sheet.pdf` : '';
}

function isValidProductPdfKey(value, productCode = '') {
  const key = String(value || '');
  const current = key.match(/^([1-9][0-9]{4})\/([1-9][0-9]{4})-print-sheet\.pdf$/);
  const previous = key.match(/^tinyframes\/products\/([1-9][0-9]{4})\/print-sheet-([1-9][0-9]{4})\.pdf$/);
  const match = current || previous;
  return Boolean(match && match[1] === match[2] && (!productCode || match[1] === productCode));
}

function getProductPdfKeyCandidates(productCode) {
  const code = normalizeProductCode(productCode);
  return code ? [
    getProductPdfKey(code),
    `tinyframes/products/${code}/print-sheet-${code}.pdf`
  ] : [];
}

function isValidProcessedImageKey(value) {
  return /^tinyframes\/tf_[a-f0-9]{32}\/processed\/(?:0[1-8])\.jpg$/.test(String(value || ''));
}

function isValidTinyFrameOriginalKey(value, uploadSessionId = '', pictureNumber = 0) {
  const key = String(value || '');
  const match = key.match(/^tinyframes\/(tf_[a-f0-9]{32})\/originals\/(0[1-8])\.(?:jpg|png|gif)$/);
  if (!match) return false;
  if (uploadSessionId && match[1] !== uploadSessionId) return false;
  if (pictureNumber && Number(match[2]) !== pictureNumber) return false;
  return true;
}

async function deleteObjectKeys(bucket, keys) {
  await Promise.allSettled(keys.map(key => bucket.delete(key)));
}

function countAscii(bytes, value) {
  const needle = new TextEncoder().encode(value);
  let count = 0;
  for (let index = 0; index <= bytes.length - needle.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) { matches = false; break; }
    }
    if (matches) { count += 1; index += needle.length - 1; }
  }
  return count;
}

function pdfNumber(value) {
  return Number(value).toFixed(6).replace(/\.?0+$/, '');
}

function inspectPrintSheetPdfStructure(structuralPrefix, imageCount, expectedProductCode = '', expectedPhotoCount = TINY_FRAME_UPLOAD_IMAGE_COUNT) {
  if (!structuralPrefix.startsWith('%PDF-')) {
    return { valid:false, error:'The print sheet is not a PDF' };
  }
  const mediaBox = `/MediaBox [0 0 ${pdfNumber(A4_WIDTH_POINTS)} ${pdfNumber(A4_HEIGHT_POINTS)}]`;
  const expectedPageCount = Math.ceil(expectedPhotoCount / TINY_FRAME_PHOTOS_PER_PAGE);
  if (countAscii(new TextEncoder().encode(structuralPrefix), mediaBox) !== expectedPageCount) {
    return { valid:false, error:'The print sheet must be an exact portrait A4 page' };
  }
  if (
    !Number.isInteger(expectedPhotoCount) || expectedPhotoCount < 1 ||
    (expectedPhotoCount !== TINY_FRAME_UPLOAD_IMAGE_COUNT && expectedPhotoCount % TINY_FRAME_PHOTOS_PER_SET !== 0) ||
    imageCount !== expectedPhotoCount
  ) {
    return { valid:false, error:'The print sheet photo count does not match the selected photo sets' };
  }
  const placements = getA4PrintLayout(expectedPhotoCount);
  for (const placement of placements) {
    const command = `q ${pdfNumber(TINY_FRAME_PHOTO_WIDTH_POINTS)} 0 0 ${pdfNumber(TINY_FRAME_PHOTO_HEIGHT_POINTS)} ${pdfNumber(placement.xMm * 72 / 25.4)} ${pdfNumber(placement.yMm * 72 / 25.4)} cm /Im${placement.index + 1} Do Q`;
    if (!structuralPrefix.includes(command)) {
      return { valid:false, error:'The print-sheet picture placements could not be verified' };
    }
    const trim = `${pdfNumber(placement.xMm * 72 / 25.4)} ${pdfNumber(placement.yMm * 72 / 25.4)} ${pdfNumber(TINY_FRAME_PHOTO_WIDTH_POINTS)} ${pdfNumber(TINY_FRAME_PHOTO_HEIGHT_POINTS)} re S`;
    if (!structuralPrefix.includes(trim)) {
      return { valid:false, error:'The print-sheet cut lines could not be verified' };
    }
  }
  if (!structuralPrefix.includes(`${pdfNumber(PRINT_SHEET_SPECIFICATION.guideWidthPt)} w`)) {
    return { valid:false, error:'The print-sheet cut-line width could not be verified' };
  }
  const productCode = normalizeProductCode(expectedProductCode);
  if (expectedProductCode && !productCode) return { valid:false, error:'The product code is invalid' };
  if (productCode && !structuralPrefix.includes(`(PRODUCT ${productCode}) Tj`)) {
    return { valid:false, error:'The print sheet does not contain the matching product code' };
  }
  return { valid:true };
}

function inspectPrintSheetPdf(bytes, expectedProductCode = '', expectedPhotoCount = TINY_FRAME_UPLOAD_IMAGE_COUNT) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 5) {
    return { valid:false, error:'The print sheet is not a PDF' };
  }
  const structuralPrefix = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 512 * 1024)));
  return inspectPrintSheetPdfStructure(
    structuralPrefix,
    countAscii(bytes, '/Subtype /Image'),
    expectedProductCode,
    expectedPhotoCount
  );
}

async function readR2Range(bucket, objectKey, offset, length) {
  const object = await bucket.get(objectKey, { range:{ offset, length } });
  if (!object?.body) throw new Error('The uploaded print sheet could not be read');
  const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
  if (bytes.length !== length) throw new Error('The uploaded print sheet range is incomplete');
  return bytes;
}

async function inspectStoredPrintSheetPdf(bucket, objectKey, expectedSize, expectedProductCode, expectedPhotoCount = TINY_FRAME_UPLOAD_IMAGE_COUNT) {
  try {
    const rangeLength = Math.min(expectedSize, 512 * 1024);
    const tailOffset = expectedSize - rangeLength;
    const [prefix, tail] = await Promise.all([
      readR2Range(bucket, objectKey, 0, rangeLength),
      tailOffset === 0
        ? readR2Range(bucket, objectKey, 0, rangeLength)
        : readR2Range(bucket, objectKey, tailOffset, rangeLength)
    ]);
    const tailText = new TextDecoder('latin1').decode(tail);
    const xrefIndex = tailText.lastIndexOf('\nxref\n');
    const startXrefMatch = tailText.match(/startxref\n(\d+)\n%%EOF\s*$/);
    if (xrefIndex < 0 || !startXrefMatch || Number(startXrefMatch[1]) !== tailOffset + xrefIndex + 1) {
      return { valid:false, error:'The uploaded print sheet cross-reference is invalid' };
    }
    const xrefLines = tailText.slice(xrefIndex + 1).split('\n');
    const sectionMatch = xrefLines[1]?.match(/^0 (\d+)$/);
    const objectCount = Number(sectionMatch?.[1] || 0);
    if (!Number.isInteger(objectCount) || objectCount < 2 || objectCount > 10000 || xrefLines.length < objectCount + 2) {
      return { valid:false, error:'The uploaded print sheet cross-reference is invalid' };
    }
    const offsets = [];
    for (let index = 1; index < objectCount; index += 1) {
      const entry = xrefLines[index + 2]?.match(/^(\d{10}) 00000 n $/);
      const objectOffset = Number(entry?.[1]);
      if (!entry || !Number.isSafeInteger(objectOffset) || objectOffset < 0 || objectOffset >= expectedSize) {
        return { valid:false, error:'The uploaded print sheet cross-reference is invalid' };
      }
      offsets.push(objectOffset);
    }
    const objectHeaders = await Promise.all(offsets.map((objectOffset, index) => {
      const nextOffset = index + 1 < offsets.length ? offsets[index + 1] : Number(startXrefMatch[1]);
      return readR2Range(bucket, objectKey, objectOffset, Math.min(512, nextOffset - objectOffset));
    }));
    const imageCount = objectHeaders.reduce(
      (sum, bytes) => sum + countAscii(bytes, '/Subtype /Image'),
      0
    );
    return inspectPrintSheetPdfStructure(
      new TextDecoder('latin1').decode(prefix),
      imageCount,
      expectedProductCode,
      expectedPhotoCount
    );
  } catch (error) {
    return { valid:false, error:String(error?.message || 'The uploaded print sheet could not be read') };
  }
}

function getOriginalExtension(contentType) {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/gif') return 'gif';
  return 'jpg';
}

function normalizeTinyFrameCrop(value, index) {
  if (!value || typeof value !== 'object') {
    throw new Error(`Crop information for picture ${index + 1} is missing`);
  }
  const crop = {
    x:Number(value.x),
    y:Number(value.y),
    width:Number(value.width),
    height:Number(value.height),
    sourceWidth:Number(value.sourceWidth),
    sourceHeight:Number(value.sourceHeight),
    rotation:Number(value.rotation || 0)
  };
  if (
    !Object.values(crop).every(Number.isFinite) ||
    crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 ||
    crop.sourceWidth <= 0 || crop.sourceHeight <= 0 ||
    ![0, 90].includes(crop.rotation)
  ) {
    throw new Error(`Crop information for picture ${index + 1} is invalid`);
  }

  const left = Math.max(0, Math.floor(crop.x));
  const top = Math.max(0, Math.floor(crop.y));
  const right = Math.min(Math.round(crop.sourceWidth), Math.ceil(crop.x + crop.width));
  const bottom = Math.min(Math.round(crop.sourceHeight), Math.ceil(crop.y + crop.height));
  const width = right - left;
  const height = bottom - top;
  const outputWidth = crop.rotation === 90 ? height : width;
  const outputHeight = crop.rotation === 90 ? width : height;
  if (width < 1 || height < 1 || right > crop.sourceWidth + 1 || bottom > crop.sourceHeight + 1) {
    throw new Error(`Crop information for picture ${index + 1} is outside the original image`);
  }
  if (Math.abs((outputWidth / outputHeight) - (54 / 86)) > 0.01) {
    throw new Error(`Crop information for picture ${index + 1} does not match the 54 x 86 mm print ratio`);
  }
  return { ...crop, left, top, width, height, outputWidth, outputHeight };
}

function calculateEffectivePpi(width, height) {
  return Math.min(width / TINY_FRAME_PHOTO_WIDTH_INCHES, height / TINY_FRAME_PHOTO_HEIGHT_INCHES);
}

async function transformOriginalForPrint(env, sourceBytes, crop) {
  // Edge offsets map Cropper's x/y/width/height model directly and avoid
  // ambiguity when a crop does not begin at the source image origin.
  const right = Math.max(0, Math.round(crop.sourceWidth) - crop.left - crop.width);
  const bottom = Math.max(0, Math.round(crop.sourceHeight) - crop.top - crop.height);
  let transform = env.IMAGES
    .input(sourceBytes)
    .transform({
      trim:{ top:crop.top, right, bottom, left:crop.left },
      metadata:'keep'
    });
  if (crop.rotation === 90) {
    transform = transform.transform({ rotate:90 });
  }
  const output = await transform.output({ format:'image/jpeg', quality:100 });
  const response = output.response();
  if (!response.ok) {
    throw new Error(`Cloudflare Images returned ${response.status} while preparing a print crop`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function uploadTinyFrameOriginal(request, env) {
  if (!env.ARTWORK_BUCKET) {
    return jsonResponse(request, env, { error:'Artwork storage is not configured' }, 503);
  }
  if (!env.IMAGES) {
    return jsonResponse(request, env, { error:'Print-quality image processing is not configured' }, 503);
  }
  if (!getAllowedOrigin(request, env)) {
    return jsonResponse(request, env, { error:'Origin is not allowed' }, 403);
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse(request, env, { error:'Upload must use multipart form data' }, 400);
  }
  const uploadSessionId = normalizeUploadReference(formData.get('upload_session_id'));
  const pictureNumber = Number(formData.get('picture_number'));
  const file = formData.get('file');
  if (!uploadSessionId) {
    return jsonResponse(request, env, { error:'Upload session ID is invalid' }, 400);
  }
  if (!Number.isInteger(pictureNumber) || pictureNumber < 1 || pictureNumber > TINY_FRAME_UPLOAD_IMAGE_COUNT) {
    return jsonResponse(request, env, { error:'Picture number must be between 1 and 8' }, 400);
  }
  if (!file || typeof file.arrayBuffer !== 'function') {
    return jsonResponse(request, env, { error:'An original photograph is required' }, 400);
  }
  if (!SUPPORTED_TINY_FRAME_IMAGE_TYPES.includes(file.type)) {
    return jsonResponse(request, env, { error:'Photos must be JPEG, PNG, or GIF files' }, 400);
  }
  if (!file.size || file.size > MAX_TINY_FRAME_ORIGINAL_BYTES) {
    return jsonResponse(request, env, { error:'Each original picture must be 20 MB or smaller' }, 413);
  }

  const objectKey = `${getTinyFrameUploadPrefix(uploadSessionId)}originals/${String(pictureNumber).padStart(2, '0')}.${getOriginalExtension(file.type)}`;
  const existing = await env.ARTWORK_BUCKET.head(objectKey);
  if (existing) {
    const sameFile = Number(existing.customMetadata?.original_size_bytes) === file.size &&
      existing.customMetadata?.content_type === file.type;
    if (!sameFile) {
      return jsonResponse(request, env, {
        error:'This picture slot already contains a different file.',
        code:'UPLOAD_SLOT_CONFLICT'
      }, 409);
    }
    return jsonResponse(request, env, {
      success:true,
      retry_recovered:true,
      original:{ objectKey, contentType:file.type, size:file.size }
    });
  }

  const diagnosticId = crypto.randomUUID().slice(0, 8);
  try {
    const sourceBuffer = await file.arrayBuffer();
    const info = await env.IMAGES.info(sourceBuffer);
    const sourceWidth = Number(info?.width);
    const sourceHeight = Number(info?.height);
    if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight)) {
      throw new TinyFrameInputError('The picture dimensions could not be read');
    }
    const stored = await env.ARTWORK_BUCKET.put(objectKey, sourceBuffer, {
      httpMetadata:{ contentType:file.type },
      customMetadata:{
        upload_session_id:uploadSessionId,
        picture_number:String(pictureNumber),
        original_filename:String(file.name || `picture-${pictureNumber}`).slice(0, 512),
        original_size_bytes:String(file.size),
        content_type:file.type,
        source_width_px:String(sourceWidth),
        source_height_px:String(sourceHeight),
        status:'uploading',
        created_at:new Date().toISOString()
      },
      onlyIf:{ etagDoesNotMatch:'*' }
    });
    if (stored === null) {
      return jsonResponse(request, env, { error:'The picture slot was updated by another request' }, 409);
    }
    return jsonResponse(request, env, {
      success:true,
      original:{ objectKey, contentType:file.type, size:file.size, width:sourceWidth, height:sourceHeight }
    });
  } catch (error) {
    console.error('Tiny Frame original upload failed', {
      diagnosticId,
      stage:'storing_original',
      pictureNumber,
      errorName:String(error?.name || 'Error'),
      message:String(error?.message || 'Unknown upload failure')
    });
    return jsonResponse(request, env, {
      error:error instanceof TinyFrameInputError
        ? error.message
        : 'We could not store this picture. Your selections are still here, so please try again.',
      code:error instanceof TinyFrameInputError ? 'INVALID_ORIGINAL' : 'ORIGINAL_STORAGE_FAILED',
      stage:'storing_original',
      picture_number:pictureNumber,
      diagnostic_id:diagnosticId
    }, error instanceof TinyFrameInputError ? 400 : 500);
  }
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
  for (let attempt = 0; !sessionRecord && attempt < 6; attempt += 1) {
    const storageFolder = formatBrisbaneUploadFolder(
      new Date(createdAt),
      attempt ? crypto.randomUUID().replaceAll('-', '').slice(0, 4) : ''
    );
    await env.PRODUCT_CODES_DB.prepare(
      `INSERT OR IGNORE INTO photo_upload_sessions
        (upload_session_id, cart_item_id, upload_token_hash, status, selection_json,
         selection_version, state_version, photo_set_count, product_codes_json,
         storage_folder, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', '[]', 0, 0, 1, '[]', ?, ?, ?)`
    ).bind(uploadSessionId, cartItemId, tokenHash, storageFolder, createdAt, createdAt).run();
    sessionRecord = await getPhotoUploadSession(env.PRODUCT_CODES_DB, uploadSessionId);
  }
  if (
    !sessionRecord || sessionRecord.cart_item_id !== cartItemId ||
    sessionRecord.upload_token_hash !== tokenHash
  ) return jsonResponse(request, env, { error:'This upload session is already in use', code:'UPLOAD_SESSION_CONFLICT' }, 409);
  const storageFolder = getPhotoUploadStorageFolder(sessionRecord, uploadSessionId);
  const manifestKey = getUploadManifestKey(uploadSessionId, storageFolder);
  const existing = await env.ARTWORK_BUCKET.get(manifestKey);
  if (existing) {
    const manifest = await readR2Json(existing);
    if (manifest?.upload_session_id !== uploadSessionId || ![LEGACY_INDIVIDUAL_PHOTO_STORAGE_VERSION, INDIVIDUAL_PHOTO_STORAGE_VERSION].includes(Number(manifest.storage_version))) {
      return jsonResponse(request, env, { error:'This upload session is already in use', code:'UPLOAD_SESSION_CONFLICT' }, 409);
    }
    return jsonResponse(request, env, { success:true, uploadSessionId, storageFolder, selectionVersion:Number(sessionRecord.selection_version), recovered:true });
  }
  const stored = await env.ARTWORK_BUCKET.put(manifestKey, JSON.stringify({
    storage_version:INDIVIDUAL_PHOTO_STORAGE_VERSION,
    upload_session_id:uploadSessionId,
    storage_folder:storageFolder,
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
  return jsonResponse(request, env, { success:true, uploadSessionId, storageFolder, selectionVersion:Number(sessionRecord.selection_version) });
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
          ? { ...photo, object_key:previous.object_key, status:'uploaded' }
          : photo;
      });
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
    const { sessionRecord, storageFolder } = await requireIndividualUploadSession(request, env, uploadSessionId);
    await enforceIndividualUploadRateLimit(env, `${request.headers.get('CF-Connecting-IP') || 'unknown'}:${uploadSessionId}`);
    if (sessionRecord) {
      const selection = photoUploadSelection(sessionRecord);
      const selected = selection.find(photo => photo?.photo_id === photoId && photo?.revision === revision);
      if (sessionRecord.status !== 'draft' || !selected) {
        return jsonResponse(request, env, { error:'This photo has been replaced or removed', code:'PHOTO_SUPERSEDED' }, 409);
      }
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
      const objectKey = getTemporaryPhotoKey(uploadSessionId, storageFolder);
      const createdAt = new Date().toISOString();
      const stored = await env.ARTWORK_BUCKET.put(objectKey, bytes, {
        httpMetadata:{ contentType:'image/jpeg' },
        customMetadata:{
          upload_session_id:uploadSessionId,
          photo_id:photoId,
          revision,
          width_px:String(width),
          height_px:String(height),
          effective_ppi:String(Number(calculateEffectivePpi(width, height).toFixed(1))),
          status:'temporary',
          created_at:createdAt
        },
        onlyIf:{ etagDoesNotMatch:'*' }
      });
      if (stored === null) throw new Error('R2 could not create an immutable photo object');
      const confirmed = await env.ARTWORK_BUCKET.head(objectKey);
      if (
        !confirmed || Number(confirmed.size || 0) !== file.size ||
        confirmed.httpMetadata?.contentType !== 'image/jpeg' ||
        confirmed.customMetadata?.upload_session_id !== uploadSessionId ||
        confirmed.customMetadata?.photo_id !== photoId ||
        confirmed.customMetadata?.revision !== revision
      ) throw new Error('R2 did not confirm the stored photo');
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = await getPhotoUploadSession(env.PRODUCT_CODES_DB, uploadSessionId);
        const currentSelection = photoUploadSelection(current);
        const activeIndex = currentSelection.findIndex(photo =>
          photo?.photo_id === photoId && photo?.revision === revision
        );
        if (!current || current.status !== 'draft' || activeIndex < 0) {
          await env.ARTWORK_BUCKET.delete(objectKey);
          return jsonResponse(request, env, { error:'This photo was replaced while uploading', code:'PHOTO_SUPERSEDED' }, 409);
        }
        if (currentSelection[activeIndex].object_key) {
          await env.ARTWORK_BUCKET.delete(objectKey);
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
      await env.ARTWORK_BUCKET.delete(objectKey);
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
      stage:'r2-upload',
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
  try {
    const { manifestKey, manifest, sessionRecord, storageFolder } = await requireIndividualUploadSession(request, env, uploadSessionId);
    if (sessionRecord) {
      if (sessionRecord.cart_item_id !== cartItemId) throw new TinyFrameInputError('Photo upload does not match this product');
      let snapshot = parsePhotoUploadJson(sessionRecord.snapshot_json, null);
      if (['finalized', 'checkout_pending', 'paid'].includes(sessionRecord.status) && snapshot) {
        if (
          snapshot.frame_colour !== frameColour ||
          Number(snapshot.photo_set_count) !== photoSetCount ||
          snapshot.photos.length !== expectedPhotoCount
        ) throw new TinyFrameInputError('This photo selection has already been finalized');
      } else {
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
        const stored = await Promise.all(selection.map(photo => env.ARTWORK_BUCKET.head(photo.object_key)));
        if (stored.some((object, index) =>
          !object ||
          object.customMetadata?.upload_session_id !== uploadSessionId ||
          object.customMetadata?.photo_id !== selection[index].photo_id ||
          object.customMetadata?.revision !== selection[index].revision
        )) throw new TinyFrameInputError('One or more selected photos could not be verified in temporary storage');
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
    return jsonResponse(request, env, { error:error.message || 'Photo upload could not be finalized' }, error instanceof TinyFrameInputError ? 400 : 500);
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
    return jsonResponse(request, env, { error:error.message || 'Upload session could not be read' }, error instanceof TinyFrameInputError ? 400 : 500);
  }
}

async function finalizeTinyFrameUpload(request, env) {
  if (!env.ARTWORK_BUCKET) {
    return jsonResponse(request, env, { error:'Artwork storage is not configured' }, 503);
  }
  if (!env.IMAGES) {
    return jsonResponse(request, env, { error:'Print-quality image processing is not configured' }, 503);
  }
  if (!getAllowedOrigin(request, env)) {
    return jsonResponse(request, env, { error:'Origin is not allowed' }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, env, { error:'Finalize request must be valid JSON' }, 400);
  }
  const uploadSessionId = normalizeUploadReference(body?.uploadSessionId);
  const frameColour = normalizeFrameColour(body?.frameColour);
  const originalKeys = Array.isArray(body?.originalObjectKeys) ? body.originalObjectKeys : [];
  let crops;
  try {
    if (body?.crops?.length !== TINY_FRAME_UPLOAD_IMAGE_COUNT) throw new Error('Exactly 8 crops are required');
    crops = body.crops.map(normalizeTinyFrameCrop);
  } catch (error) {
    return jsonResponse(request, env, { error:error.message || 'Crop information is invalid' }, 400);
  }
  if (!uploadSessionId || !frameColour) {
    return jsonResponse(request, env, { error:'Upload session or frame colour is invalid' }, 400);
  }
  if (
    originalKeys.length !== TINY_FRAME_UPLOAD_IMAGE_COUNT ||
    originalKeys.some((key, index) => !isValidTinyFrameOriginalKey(key, uploadSessionId, index + 1))
  ) {
    return jsonResponse(request, env, { error:'All 8 stored original photographs are required' }, 400);
  }

  const manifestKey = getUploadManifestKey(uploadSessionId);
  const existingManifestObject = await env.ARTWORK_BUCKET.get(manifestKey);
  if (existingManifestObject) {
    const manifest = await readR2Json(existingManifestObject);
    const files = Array.isArray(manifest?.files) ? manifest.files : [];
    const valid = manifest?.upload_session_id === uploadSessionId &&
      manifest?.frame_colour === frameColour &&
      manifest?.image_count === TINY_FRAME_UPLOAD_IMAGE_COUNT &&
      files.length >= 16;
    if (!valid) {
      return jsonResponse(request, env, { error:'This upload reference is already in use' }, 409);
    }
    const storedFiles = await Promise.all(files.map(file => env.ARTWORK_BUCKET.head(file.objectKey)));
    if (storedFiles.some(file => !file)) {
      return jsonResponse(request, env, { error:'A previous upload was incomplete. Please try again.' }, 409);
    }
    return jsonResponse(request, env, {
      success:true,
      retry_recovered:true,
      upload_session_id:uploadSessionId,
      manifest:{ objectKey:manifestKey },
      image_quality:Array.isArray(manifest.image_quality) ? manifest.image_quality : [],
      warnings:(Array.isArray(manifest.image_quality) ? manifest.image_quality : [])
        .filter(item => item.below_200_ppi)
        .map(item => `Picture ${item.picture_number} is ${Math.round(item.effective_ppi)} PPI at 54 x 86 mm`)
    });
  }

  const diagnosticId = crypto.randomUUID().slice(0, 8);
  const createdAt = new Date().toISOString();
  const processedFiles = [];
  const originalFiles = [];
  const imageQuality = [];
  let uploadStage = 'verifying_original';
  let pictureNumber = null;
  try {
    for (let index = 0; index < TINY_FRAME_UPLOAD_IMAGE_COUNT; index += 1) {
      pictureNumber = index + 1;
      const originalObject = await env.ARTWORK_BUCKET.get(originalKeys[index]);
      if (!originalObject) throw new TinyFrameInputError(`Original picture ${pictureNumber} could not be found`);
      const sourceWidth = Number(originalObject.customMetadata?.source_width_px);
      const sourceHeight = Number(originalObject.customMetadata?.source_height_px);
      const submittedCrop = crops[index];
      if (
        !Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) ||
        Math.abs(sourceWidth - submittedCrop.sourceWidth) > 1 ||
        Math.abs(sourceHeight - submittedCrop.sourceHeight) > 1
      ) {
        throw new TinyFrameInputError(`Original picture ${pictureNumber} does not match its saved crop information`);
      }
      uploadStage = 'reading_original';
      const sourceBuffer = await new Response(originalObject.body).arrayBuffer();
      uploadStage = 'processing_crop';
      const processedBytes = await transformOriginalForPrint(env, sourceBuffer, submittedCrop);
      const processedDimensions = readJpegDimensions(processedBytes);
      const processedObjectKey = `${getTinyFrameUploadPrefix(uploadSessionId)}processed/${String(pictureNumber).padStart(2, '0')}.jpg`;
      uploadStage = 'storing_processed_crop';
      await env.ARTWORK_BUCKET.put(processedObjectKey, processedBytes, {
        httpMetadata:{ contentType:'image/jpeg' },
        customMetadata:{
          upload_session_id:uploadSessionId,
          picture_number:String(pictureNumber),
          status:'pending',
          created_at:createdAt
        }
      });
      const effectivePpi = calculateEffectivePpi(processedDimensions.width, processedDimensions.height);
      const quality = {
        picture_number:pictureNumber,
        cropped_width_px:processedDimensions.width,
        cropped_height_px:processedDimensions.height,
        effective_ppi:Number(effectivePpi.toFixed(1)),
        below_200_ppi:effectivePpi < TINY_FRAME_LOW_RESOLUTION_PPI
      };
      imageQuality.push(quality);
      processedFiles.push({
        filename:`processed-${String(pictureNumber).padStart(2, '0')}.jpg`,
        objectKey:processedObjectKey,
        contentType:'image/jpeg',
        size:processedBytes.length,
        ...quality
      });
      originalFiles.push({
        filename:String(originalObject.customMetadata?.original_filename || `picture-${pictureNumber}`).slice(0, 512),
        objectKey:originalKeys[index],
        contentType:String(originalObject.customMetadata?.content_type || 'application/octet-stream'),
        size:Number(originalObject.customMetadata?.original_size_bytes || 0),
        width_px:sourceWidth,
        height_px:sourceHeight,
        crop:{
          x:submittedCrop.left,
          y:submittedCrop.top,
          width:submittedCrop.width,
          height:submittedCrop.height,
          rotation:submittedCrop.rotation
        },
        ...quality
      });
    }

    pictureNumber = null;
    uploadStage = 'storing_manifest';
    const manifest = {
      upload_session_id:uploadSessionId,
      frame_colour:frameColour,
      product_type:'frame_8_pictures',
      image_count:TINY_FRAME_UPLOAD_IMAGE_COUNT,
      page_size_mm:{ width:210, height:297 },
      photo_width_mm:54,
      photo_height_mm:86,
      photo_size_mm:{ width:54, height:86 },
      cutting_guides:{
        line_width_pt:PRINT_SHEET_SPECIFICATION.guideWidthPt,
        colour:'light-grey',
        crop_mark_gap_mm:PRINT_SHEET_SPECIFICATION.cropMarkGapMm,
        crop_mark_length_mm:PRINT_SHEET_SPECIFICATION.cropMarkLengthMm
      },
      image_quality:imageQuality,
      quality_warning_count:imageQuality.filter(item => item.below_200_ppi).length,
      originals:originalFiles,
      processed_images:processedFiles,
      product_codes:[],
      print_sheets:[],
      files:[...processedFiles, ...originalFiles],
      status:'pending',
      created_at:createdAt,
      generated_at:createdAt,
      uploaded_at:createdAt
    };
    const stored = await env.ARTWORK_BUCKET.put(manifestKey, JSON.stringify(manifest), {
      httpMetadata:{ contentType:'application/json' },
      onlyIf:{ etagDoesNotMatch:'*' }
    });
    if (stored === null) throw new Error('Upload session was finalized by another request');
    return jsonResponse(request, env, {
      success:true,
      upload_session_id:uploadSessionId,
      manifest:{ objectKey:manifestKey },
      image_quality:imageQuality,
      warnings:imageQuality
        .filter(item => item.below_200_ppi)
        .map(item => `Picture ${item.picture_number} is ${Math.round(item.effective_ppi)} PPI at 54 x 86 mm`)
    });
  } catch (error) {
    console.error('Tiny Frame upload finalization failed', {
      diagnosticId,
      stage:uploadStage,
      pictureNumber,
      errorName:String(error?.name || 'Error'),
      message:String(error?.message || 'Unknown upload failure')
    });
    return jsonResponse(request, env, {
      error:error instanceof TinyFrameInputError
        ? error.message
        : 'We could not prepare your photos. Your uploaded originals are safe, so please try again.',
      code:error instanceof TinyFrameInputError ? 'INVALID_UPLOAD_INPUT' : 'UPLOAD_PROCESSING_FAILED',
      stage:uploadStage,
      picture_number:pictureNumber,
      diagnostic_id:diagnosticId
    }, error instanceof TinyFrameInputError ? 400 : 500);
  }
}

async function uploadTinyFramePrintSheet(request, env) {
  if (!env.ARTWORK_BUCKET) {
    return jsonResponse(request, env, { error: 'Artwork storage is not configured' }, 503);
  }
  if (!env.IMAGES) {
    return jsonResponse(request, env, { error: 'Print-quality image processing is not configured' }, 503);
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

  const requestedSessionId = String(formData.get('upload_session_id') || '').trim().toLowerCase();
  const uploadSessionId = requestedSessionId || createUploadSessionId();
  const frameColour = normalizeFrameColour(formData.get('frame_colour'));
  const imageCount = Number(formData.get('image_count'));
  const originals = Array.from(
    { length:TINY_FRAME_UPLOAD_IMAGE_COUNT },
    (_, index) => formData.get(`original_${index + 1}`)
  );
  let crops;
  try {
    const cropValues = JSON.parse(String(formData.get('crop_metadata') || ''));
    if (!Array.isArray(cropValues) || cropValues.length !== TINY_FRAME_UPLOAD_IMAGE_COUNT) {
      throw new Error('Exactly 8 crops are required');
    }
    crops = cropValues.map(normalizeTinyFrameCrop);
  } catch (error) {
    return jsonResponse(request, env, { error:error.message || 'Crop information is invalid' }, 400);
  }
  if (!normalizeUploadReference(uploadSessionId)) {
    return jsonResponse(request, env, { error: 'Upload session ID is invalid' }, 400);
  }
  if (!frameColour) {
    return jsonResponse(request, env, { error: 'Frame colour must be Oak or Walnut' }, 400);
  }
  if (imageCount !== TINY_FRAME_UPLOAD_IMAGE_COUNT) {
    return jsonResponse(request, env, { error: 'The print sheet must represent exactly 8 cropped images' }, 400);
  }
  if (originals.some(file => !file || typeof file.arrayBuffer !== 'function')) {
    return jsonResponse(request, env, { error: 'All 8 original photographs are required' }, 400);
  }
  if (originals.some(file => !SUPPORTED_TINY_FRAME_IMAGE_TYPES.includes(file.type))) {
    return jsonResponse(request, env, { error: 'Photos must be JPEG, PNG, or GIF files' }, 400);
  }
  if (originals.some(file => !file.size || file.size > MAX_TINY_FRAME_ORIGINAL_BYTES)) {
    return jsonResponse(request, env, { error: 'Each original picture must be 20 MB or smaller' }, 413);
  }
  if (originals.reduce((sum, file) => sum + file.size, 0) > MAX_TINY_FRAME_UPLOAD_BYTES) {
    return jsonResponse(request, env, { error: 'The combined original photos exceed the 96 MB upload limit' }, 413);
  }

  const manifestKey = getUploadManifestKey(uploadSessionId);
  const existingManifestObject = await env.ARTWORK_BUCKET.get(manifestKey);
  if (existingManifestObject) {
    const existingManifest = await readR2Json(existingManifestObject);
    const existingFiles = Array.isArray(existingManifest?.files) ? existingManifest.files : [];
    const expectedPrefix = getTinyFrameUploadPrefix(uploadSessionId);
    const validExistingUpload = existingManifest?.upload_session_id === uploadSessionId &&
      existingManifest?.frame_colour === frameColour &&
      existingManifest?.image_count === TINY_FRAME_UPLOAD_IMAGE_COUNT &&
      existingFiles.length === 17 &&
      existingFiles.every(file => String(file?.objectKey || '').startsWith(expectedPrefix));
    if (!validExistingUpload) {
      return jsonResponse(request, env, {
        error:'This upload reference is already in use. Please try adding the product again.',
        code:'UPLOAD_REFERENCE_CONFLICT'
      }, 409);
    }
    const storedFiles = await Promise.all(existingFiles.map(file => env.ARTWORK_BUCKET.head(file.objectKey)));
    if (storedFiles.some(file => !file)) {
      return jsonResponse(request, env, {
        error:'A previous upload was incomplete. Please try again.',
        code:'UPLOAD_INCOMPLETE'
      }, 409);
    }
    return jsonResponse(request, env, {
      success:true,
      upload_session_id:uploadSessionId,
      retry_recovered:true,
      print_sheet:{
        filename:existingManifest.print_sheet_filename,
        objectKey:existingManifest.print_sheet_object_key,
        contentType:'application/pdf',
        size:Number(existingFiles.find(file => file.objectKey === existingManifest.print_sheet_object_key)?.size || 0),
        downloadUrl:getArtworkUrl(request, existingManifest.print_sheet_object_key)
      },
      image_quality:Array.isArray(existingManifest.image_quality) ? existingManifest.image_quality : [],
      warnings:(Array.isArray(existingManifest.image_quality) ? existingManifest.image_quality : [])
        .filter(item => item.below_200_ppi)
        .map(item => `Picture ${item.picture_number} is ${Math.round(item.effective_ppi)} PPI at 54 x 86 mm`)
    });
  }

  const storedKeys = [];
  const printSheetFilename = 'print-sheet-a4.pdf';
  const printSheetObjectKey = `${getTinyFrameUploadPrefix(uploadSessionId)}${printSheetFilename}`;
  const createdAt = new Date().toISOString();
  const diagnosticId = crypto.randomUUID().slice(0, 8);
  let uploadStage = 'initializing';
  let pictureNumber = null;
  try {
    const processedImages = [];
    const processedFiles = [];
    const originalFiles = [];
    const imageQuality = [];

    for (let index = 0; index < originals.length; index += 1) {
      pictureNumber = index + 1;
      const file = originals[index];
      uploadStage = 'reading_original';
      const sourceBuffer = await file.arrayBuffer();
      const sourceBytes = new Uint8Array(sourceBuffer);
      uploadStage = 'reading_dimensions';
      const info = await env.IMAGES.info(sourceBuffer);
      const sourceWidth = Number(info?.width);
      const sourceHeight = Number(info?.height);
      if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight)) {
        throw new Error(`The dimensions of original picture ${index + 1} could not be read`);
      }
      const submittedCrop = crops[index];
      if (
        Math.abs(sourceWidth - submittedCrop.sourceWidth) > 1 ||
        Math.abs(sourceHeight - submittedCrop.sourceHeight) > 1
      ) {
        throw new TinyFrameInputError(`Original picture ${index + 1} does not match its saved crop information`);
      }

      const originalObjectKey = `${getTinyFrameUploadPrefix(uploadSessionId)}originals/${String(index + 1).padStart(2, '0')}.${getOriginalExtension(file.type)}`;
      uploadStage = 'storing_original';
      const storedOriginal = await env.ARTWORK_BUCKET.put(originalObjectKey, sourceBytes, {
        httpMetadata:{ contentType:file.type },
        customMetadata:{
          upload_session_id:uploadSessionId,
          picture_number:String(index + 1),
          original_filename:String(file.name || `picture-${index + 1}`).slice(0, 512),
          source_width_px:String(sourceWidth),
          source_height_px:String(sourceHeight),
          status:'pending',
          created_at:createdAt
        },
        onlyIf:{ etagDoesNotMatch:'*' }
      });
      if (storedOriginal === null) throw new Error('Upload session already exists');
      storedKeys.push(originalObjectKey);

      uploadStage = 'processing_crop';
      const processedBytes = await transformOriginalForPrint(env, sourceBuffer, submittedCrop);
      const processedDimensions = readJpegDimensions(processedBytes);
      const processedObjectKey = `${getTinyFrameUploadPrefix(uploadSessionId)}processed/${String(index + 1).padStart(2, '0')}.jpg`;
      uploadStage = 'storing_processed_crop';
      const storedProcessed = await env.ARTWORK_BUCKET.put(processedObjectKey, processedBytes, {
        httpMetadata:{ contentType:'image/jpeg' },
        customMetadata:{
          upload_session_id:uploadSessionId,
          picture_number:String(index + 1),
          status:'pending',
          created_at:createdAt
        },
        onlyIf:{ etagDoesNotMatch:'*' }
      });
      if (storedProcessed === null) throw new Error('Upload session already exists');
      storedKeys.push(processedObjectKey);
      const effectivePpi = calculateEffectivePpi(processedDimensions.width, processedDimensions.height);
      const quality = {
        picture_number:index + 1,
        cropped_width_px:processedDimensions.width,
        cropped_height_px:processedDimensions.height,
        effective_ppi:Number(effectivePpi.toFixed(1)),
        below_200_ppi:effectivePpi < TINY_FRAME_LOW_RESOLUTION_PPI
      };
      imageQuality.push(quality);
      processedImages.push({ bytes:processedBytes });
      processedFiles.push({
        filename:`processed-${String(index + 1).padStart(2, '0')}.jpg`,
        objectKey:processedObjectKey,
        contentType:'image/jpeg',
        size:processedBytes.length,
        ...quality
      });
      originalFiles.push({
        filename:String(file.name || `picture-${index + 1}`).slice(0, 512),
        objectKey:originalObjectKey,
        contentType:file.type,
        size:file.size,
        width_px:sourceWidth,
        height_px:sourceHeight,
        crop:{
          x:submittedCrop.left,
          y:submittedCrop.top,
          width:submittedCrop.width,
          height:submittedCrop.height,
          rotation:submittedCrop.rotation
        },
        ...quality
      });
    }

    pictureNumber = null;
    uploadStage = 'generating_pdf';
    const pdfBytes = createA4PrintSheetPdf(processedImages);
    if (pdfBytes.length > MAX_TINY_FRAME_PDF_BYTES) {
      throw new Error('The generated PDF exceeds the 95 MB storage limit');
    }
    const pdfInspection = inspectPrintSheetPdf(pdfBytes);
    if (!pdfInspection.valid) throw new Error(pdfInspection.error);

    uploadStage = 'storing_pdf';
    const storedPrintSheet = await env.ARTWORK_BUCKET.put(printSheetObjectKey, pdfBytes, {
      httpMetadata: { contentType:'application/pdf' },
      customMetadata: {
        upload_session_id:uploadSessionId,
        product_type:'frame_8_pictures',
        frame_colour:frameColour.toLowerCase(),
        image_count:String(TINY_FRAME_UPLOAD_IMAGE_COUNT),
        photo_width_mm:'54',
        photo_height_mm:'86',
        status:'pending',
        created_at:createdAt
      },
      onlyIf: { etagDoesNotMatch:'*' }
    });
    if (storedPrintSheet === null) throw new Error('Upload session already exists');
    storedKeys.push(printSheetObjectKey);

    const manifest = {
      upload_session_id:uploadSessionId,
      frame_colour:frameColour,
      product_type:'frame_8_pictures',
      image_count:TINY_FRAME_UPLOAD_IMAGE_COUNT,
      print_sheet_filename:printSheetFilename,
      print_sheet_object_key:printSheetObjectKey,
      page_size_mm:{ width:210, height:297 },
      photo_width_mm:54,
      photo_height_mm:86,
      photo_size_mm:{ width:54, height:86 },
      cutting_guides:{
        line_width_pt:PRINT_SHEET_SPECIFICATION.guideWidthPt,
        colour:'light-grey',
        crop_mark_gap_mm:PRINT_SHEET_SPECIFICATION.cropMarkGapMm,
        crop_mark_length_mm:PRINT_SHEET_SPECIFICATION.cropMarkLengthMm
      },
      image_quality:imageQuality,
      quality_warning_count:imageQuality.filter(item => item.below_200_ppi).length,
      originals:originalFiles,
      processed_images:processedFiles,
      product_codes:[],
      print_sheets:[],
      files:[{
        filename:printSheetFilename,
        objectKey:printSheetObjectKey,
        contentType:'application/pdf',
        size:pdfBytes.length
      }, ...processedFiles, ...originalFiles],
      status:'pending',
      created_at:createdAt,
      generated_at:createdAt,
      uploaded_at:createdAt
    };
    uploadStage = 'storing_manifest';
    const storedManifest = await env.ARTWORK_BUCKET.put(manifestKey, JSON.stringify(manifest), {
      httpMetadata: { contentType:'application/json' },
      onlyIf: { etagDoesNotMatch:'*' }
    });
    if (storedManifest === null) {
      throw new Error('Upload session already exists');
    }
    storedKeys.push(manifestKey);

    return jsonResponse(request, env, {
      success:true,
      upload_session_id:uploadSessionId,
      print_sheet:{
        filename:printSheetFilename,
        objectKey:printSheetObjectKey,
        contentType:'application/pdf',
        size:pdfBytes.length,
        downloadUrl:getArtworkUrl(request, printSheetObjectKey)
      },
      image_quality:imageQuality,
      warnings:imageQuality
        .filter(item => item.below_200_ppi)
        .map(item => `Picture ${item.picture_number} is ${Math.round(item.effective_ppi)} PPI at 54 x 86 mm`)
    });
  } catch (error) {
    await deleteObjectKeys(env.ARTWORK_BUCKET, storedKeys);
    if (error instanceof TinyFrameInputError) {
      return jsonResponse(request, env, {
        error:error.message,
        code:'INVALID_UPLOAD_INPUT',
        stage:uploadStage,
        diagnostic_id:diagnosticId
      }, 400);
    }
    console.error('Tiny Frame print-sheet upload failed', {
      diagnosticId,
      stage:uploadStage,
      pictureNumber,
      errorName:String(error?.name || 'Error'),
      message:String(error?.message || 'Unknown upload failure')
    });
    return jsonResponse(request, env, {
      error:'We could not prepare your photos. Your selections are still here, so please try again.',
      code:'UPLOAD_PROCESSING_FAILED',
      stage:uploadStage,
      diagnostic_id:diagnosticId
    }, 500);
  }
}

async function reserveTinyFrameProductPdf(request, env) {
  if (!env.PRODUCT_CODES_DB) {
    return jsonResponse(request, env, { error:'Product identification database is not configured' }, 503);
  }
  if (!getAllowedOrigin(request, env)) {
    return jsonResponse(request, env, { error:'Origin is not allowed' }, 403);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, env, { error:'Request body must be valid JSON' }, 400);
  }
  const cartItemId = normalizeCartItemId(body?.cartItemId);
  const frameColour = normalizeFrameColour(body?.frameColour);
  const productType = TINY_FRAME_PRODUCTS[body?.productType]
    ? body.productType
    : 'tiny_frame_8_pictures';
  const photoSetCount = productType === 'tiny_frame_8_pictures' ? 0 : normalizePhotoSetCount(body?.photoSetCount);
  if (!cartItemId || !frameColour || photoSetCount === null) {
    return jsonResponse(request, env, { error:'Cart product identity or frame colour is invalid' }, 400);
  }
  try {
    const reservation = await reserveCartProductCode(env.PRODUCT_CODES_DB, {
      cartItemId,
      productType,
      frameColour,
      unitAmount:getTinyFrameUnitAmount(productType, photoSetCount)
    }, body?.productCode ? { preferredCode:body.productCode } : {});
    if (reservation.capacity?.low) {
      console.warn('Five-digit product code capacity is running low', reservation.capacity);
    }
    const productCode = reservation.productCode;
    return jsonResponse(request, env, {
      success:true,
      productCode,
      filename:`${productCode}-print-sheet.pdf`,
      objectKey:getProductPdfKey(productCode)
    });
  } catch (error) {
    const status = error instanceof ProductCodeCapacityError ? 503 : error instanceof ProductCodeError ? 409 : 500;
    return jsonResponse(request, env, {
      error:error instanceof ProductCodeError ? error.message : 'A product code could not be reserved',
      code:String(error?.code || 'PRODUCT_CODE_RESERVATION_FAILED')
    }, status);
  }
}

async function uploadTinyFrameProductPdf(request, env) {
  if (!env.PRODUCT_CODES_DB || !env.ARTWORK_BUCKET) {
    return jsonResponse(request, env, { error:'Product storage is not configured' }, 503);
  }
  if (!getAllowedOrigin(request, env)) {
    return jsonResponse(request, env, { error:'Origin is not allowed' }, 403);
  }
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse(request, env, { error:'Upload must use multipart form data' }, 400);
  }
  const cartItemId = normalizeCartItemId(formData.get('cart_item_id'));
  const requestedProductCode = normalizeProductCode(formData.get('product_code'));
  const frameColour = normalizeFrameColour(formData.get('frame_colour'));
  const submittedPhotoSetCount = formData.get('photo_set_count');
  const submittedPhotoCount = formData.get('photo_count');
  const legacyUpload = submittedPhotoSetCount === null && submittedPhotoCount === null;
  const photoSetCount = legacyUpload ? 0 : normalizePhotoSetCount(submittedPhotoSetCount);
  const photoCount = legacyUpload ? TINY_FRAME_UPLOAD_IMAGE_COUNT : Number(submittedPhotoCount);
  const productType = legacyUpload ? 'tiny_frame_8_pictures' : 'tiny_frame_photo_sets';
  const pdf = formData.get('pdf');
  if (
    !cartItemId || !pdf || typeof pdf.arrayBuffer !== 'function' ||
    (!legacyUpload && (photoSetCount === null || photoSetCount < 1 || photoCount !== photoSetCount * TINY_FRAME_PHOTOS_PER_SET))
  ) {
    return jsonResponse(request, env, { error:'Cart identity and print-sheet PDF are required' }, 400);
  }
  const submittedFilename = String(pdf.name || '');
  const validSubmittedFilename = requestedProductCode
    ? submittedFilename === `${requestedProductCode}-print-sheet.pdf`
    : submittedFilename === 'print-sheet.pdf';
  if (pdf.type !== 'application/pdf' || !validSubmittedFilename || (!requestedProductCode && !frameColour)) {
    return jsonResponse(request, env, { error:'The print-sheet PDF filename or file type is invalid' }, 400);
  }
  if (!pdf.size || pdf.size > MAX_TINY_FRAME_PDF_BYTES) {
    return jsonResponse(request, env, {
      error:'This print-sheet PDF must use the multipart upload endpoint',
      code:'MULTIPART_UPLOAD_REQUIRED'
    }, 413);
  }

  const diagnosticId = crypto.randomUUID().slice(0, 8);
  try {
    const reservation = await reserveCartProductCode(env.PRODUCT_CODES_DB, {
      cartItemId,
      productType,
      frameColour,
      unitAmount:getTinyFrameUnitAmount(productType, photoSetCount)
    }, requestedProductCode ? { preferredCode:requestedProductCode } : {});
    const productCode = reservation.productCode;
    if (reservation.capacity?.low) {
      console.warn('Five-digit product code capacity is running low', reservation.capacity);
    }
    if (requestedProductCode && requestedProductCode !== productCode) {
      throw new TinyFrameInputError('The reserved product code does not belong to this cart product');
    }
    const filename = `${productCode}-print-sheet.pdf`;
    const objectKey = getProductPdfKey(productCode);
    const existing = await env.ARTWORK_BUCKET.head(objectKey);
    if (existing) {
      const sameUpload = existing.customMetadata?.product_code === productCode &&
        existing.customMetadata?.cart_item_id === cartItemId &&
        existing.customMetadata?.product_type === productType &&
        Number(existing.customMetadata?.image_count || 0) === photoCount &&
        Number(existing.size || existing.contentLength || 0) === pdf.size;
      if (!sameUpload) throw new TinyFrameInputError('A different PDF is already stored for this product');
      await attachProductPdf(env.PRODUCT_CODES_DB, productCode, cartItemId, objectKey);
      return jsonResponse(request, env, {
        success:true,
        retry_recovered:true,
        productCode,
        pdf:{ filename, objectKey, size:pdf.size }
      });
    }

    const bytes = new Uint8Array(await pdf.arrayBuffer());
    const inspection = inspectPrintSheetPdf(bytes, requestedProductCode ? productCode : '', photoCount);
    if (!inspection.valid) throw new TinyFrameInputError(inspection.error);
    const createdAt = new Date().toISOString();
    const stored = await env.ARTWORK_BUCKET.put(objectKey, bytes, {
      httpMetadata:{ contentType:'application/pdf' },
      customMetadata:{
        product_code:productCode,
        cart_item_id:cartItemId,
        product_type:productType,
        ...(frameColour ? { frame_colour:frameColour.toLowerCase() } : {}),
        photo_set_count:String(photoSetCount),
        image_count:String(photoCount),
        photo_width_mm:'54',
        photo_height_mm:'86',
        status:'pending',
        created_at:createdAt
      },
      onlyIf:{ etagDoesNotMatch:'*' }
    });
    if (stored === null) throw new Error('The PDF was stored by another request; please retry');
    try {
      await attachProductPdf(env.PRODUCT_CODES_DB, productCode, cartItemId, objectKey);
    } catch (error) {
      await env.ARTWORK_BUCKET.delete(objectKey);
      throw error;
    }
    return jsonResponse(request, env, {
      success:true,
      productCode,
      pdf:{ filename, objectKey, size:bytes.length }
    });
  } catch (error) {
    console.error('Tiny Frame PDF upload failed', {
      diagnosticId,
      stage:error instanceof TinyFrameInputError ? 'pdf_validation' : 'pdf_storage',
      code:error instanceof ProductCodeError ? 'PRODUCT_IDENTITY_ERROR' : 'PDF_UPLOAD_FAILED',
      errorName:String(error?.name || 'Error')
    });
    const expected = error instanceof TinyFrameInputError || error instanceof ProductCodeError;
    return jsonResponse(request, env, {
      error:expected ? error.message : 'We could not store the print sheet. Your photos are still selected, so please try again.',
      code:String(error?.code || (expected ? 'INVALID_PRINT_SHEET' : 'PDF_STORAGE_FAILED')),
      stage:expected ? 'pdf_validation' : 'pdf_storage',
      diagnostic_id:diagnosticId
    }, expected ? 400 : 500);
  }
}

function normalizeMultipartUploadId(value) {
  const uploadId = String(value || '');
  return uploadId.length > 0 && uploadId.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(uploadId)
    ? uploadId
    : '';
}

function normalizeMultipartPdfSize(value) {
  const size = Number(value);
  return Number.isSafeInteger(size) && size > 0 && size <= MAX_TINY_FRAME_MULTIPART_PDF_BYTES ? size : 0;
}

async function getCompletedProductPdf(env, { cartItemId, productCode, fileSize }) {
  const objectKey = getProductPdfKey(productCode);
  const stored = await env.ARTWORK_BUCKET.head(objectKey);
  const storedSize = Number(stored?.size || stored?.contentLength || 0);
  if (!stored) return null;
  const productType = String(stored.customMetadata?.product_type || '');
  const photoCount = Number(stored.customMetadata?.image_count || (productType === 'tiny_frame_8_pictures' ? TINY_FRAME_UPLOAD_IMAGE_COUNT : 0));
  const storedPhotoSetCount = Number(stored.customMetadata?.photo_set_count || 0);
  if (
    storedSize !== fileSize ||
    stored.customMetadata?.product_code !== productCode ||
    stored.customMetadata?.cart_item_id !== cartItemId ||
    !['tiny_frame_8_pictures', 'tiny_frame_photo_sets'].includes(productType) ||
    (productType === 'tiny_frame_8_pictures' && photoCount !== TINY_FRAME_UPLOAD_IMAGE_COUNT) ||
    (productType === 'tiny_frame_photo_sets' && (
      !Number.isInteger(storedPhotoSetCount) || storedPhotoSetCount < 1 ||
      photoCount !== storedPhotoSetCount * TINY_FRAME_PHOTOS_PER_SET
    ))
  ) {
    throw new TinyFrameInputError('A different PDF is already stored for this product');
  }
  const inspection = await inspectStoredPrintSheetPdf(env.ARTWORK_BUCKET, objectKey, fileSize, productCode, photoCount);
  if (!inspection.valid) throw new TinyFrameInputError(inspection.error);
  await attachProductPdf(env.PRODUCT_CODES_DB, productCode, cartItemId, objectKey);
  return {
    success:true,
    retry_recovered:true,
    productCode,
    pdf:{ filename:`${productCode}-print-sheet.pdf`, objectKey, size:fileSize }
  };
}

async function createTinyFrameProductPdfMultipart(request, env) {
  if (!env.PRODUCT_CODES_DB || !env.ARTWORK_BUCKET) {
    return jsonResponse(request, env, { error:'Product storage is not configured' }, 503);
  }
  if (!getAllowedOrigin(request, env)) {
    return jsonResponse(request, env, { error:'Origin is not allowed' }, 403);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, env, { error:'Request body must be valid JSON' }, 400);
  }
  const cartItemId = normalizeCartItemId(body?.cartItemId);
  const productCode = normalizeProductCode(body?.productCode);
  const frameColour = normalizeFrameColour(body?.frameColour);
  const legacyUpload = body?.photoSetCount === undefined && body?.photoCount === undefined;
  const photoSetCount = legacyUpload ? 0 : normalizePhotoSetCount(body?.photoSetCount);
  const photoCount = legacyUpload ? TINY_FRAME_UPLOAD_IMAGE_COUNT : Number(body?.photoCount);
  const productType = legacyUpload ? 'tiny_frame_8_pictures' : 'tiny_frame_photo_sets';
  const fileSize = normalizeMultipartPdfSize(body?.fileSize);
  if (!cartItemId || !productCode || !frameColour || !fileSize || (!legacyUpload && (photoSetCount === null || photoSetCount < 1 || photoCount !== photoSetCount * TINY_FRAME_PHOTOS_PER_SET))) {
    return jsonResponse(request, env, { error:'Multipart print-sheet details are invalid' }, 400);
  }

  try {
    const reservation = await reserveCartProductCode(env.PRODUCT_CODES_DB, {
      cartItemId,
      productType,
      frameColour,
      unitAmount:getTinyFrameUnitAmount(productType, photoSetCount)
    }, { preferredCode:productCode });
    if (reservation.productCode !== productCode) {
      throw new TinyFrameInputError('The reserved product code does not belong to this cart product');
    }
    const completed = await getCompletedProductPdf(env, { cartItemId, productCode, fileSize });
    if (completed) return jsonResponse(request, env, completed);

    const objectKey = getProductPdfKey(productCode);
    const createdAt = new Date().toISOString();
    const multipart = await env.ARTWORK_BUCKET.createMultipartUpload(objectKey, {
      httpMetadata:{ contentType:'application/pdf' },
      customMetadata:{
        product_code:productCode,
        cart_item_id:cartItemId,
        product_type:productType,
        frame_colour:frameColour.toLowerCase(),
        photo_set_count:String(photoSetCount),
        image_count:String(photoCount),
        photo_width_mm:'54',
        photo_height_mm:'86',
        expected_size:String(fileSize),
        status:'pending',
        created_at:createdAt
      }
    });
    return jsonResponse(request, env, {
      success:true,
      productCode,
      uploadId:multipart.uploadId,
      partSize:TINY_FRAME_PDF_PART_BYTES,
      partCount:Math.ceil(fileSize / TINY_FRAME_PDF_PART_BYTES)
    });
  } catch (error) {
    const expected = error instanceof TinyFrameInputError || error instanceof ProductCodeError;
    return jsonResponse(request, env, {
      error:expected ? error.message : 'The large print-sheet upload could not be started',
      code:String(error?.code || (expected ? 'INVALID_PRINT_SHEET' : 'MULTIPART_CREATE_FAILED'))
    }, expected ? 400 : 500);
  }
}

async function uploadTinyFrameProductPdfPart(request, env) {
  if (!env.PRODUCT_CODES_DB || !env.ARTWORK_BUCKET) {
    return jsonResponse(request, env, { error:'Product storage is not configured' }, 503);
  }
  if (!getAllowedOrigin(request, env)) {
    return jsonResponse(request, env, { error:'Origin is not allowed' }, 403);
  }
  const url = new URL(request.url);
  const cartItemId = normalizeCartItemId(url.searchParams.get('cart_item_id'));
  const productCode = normalizeProductCode(url.searchParams.get('product_code'));
  const uploadId = normalizeMultipartUploadId(url.searchParams.get('upload_id'));
  const fileSize = normalizeMultipartPdfSize(url.searchParams.get('file_size'));
  const partNumber = Number(url.searchParams.get('part_number'));
  const partCount = fileSize ? Math.ceil(fileSize / TINY_FRAME_PDF_PART_BYTES) : 0;
  if (
    !cartItemId || !productCode || !uploadId || !fileSize ||
    !Number.isInteger(partNumber) || partNumber < 1 ||
    partNumber > partCount || partCount > MAX_TINY_FRAME_PDF_PARTS
  ) {
    return jsonResponse(request, env, { error:'Multipart upload part details are invalid' }, 400);
  }

  const record = await findProductCode(env.PRODUCT_CODES_DB, productCode);
  if (!record || record.cart_item_id !== cartItemId || !['tiny_frame_8_pictures', 'tiny_frame_photo_sets'].includes(record.product_type)) {
    return jsonResponse(request, env, { error:'This multipart upload does not belong to the cart product' }, 403);
  }
  let bytes;
  try {
    bytes = await request.arrayBuffer();
  } catch {
    return jsonResponse(request, env, { error:'The upload part could not be read' }, 400);
  }
  const expectedPartSize = partNumber === partCount
    ? fileSize - ((partCount - 1) * TINY_FRAME_PDF_PART_BYTES)
    : TINY_FRAME_PDF_PART_BYTES;
  if (bytes.byteLength !== expectedPartSize) {
    return jsonResponse(request, env, { error:'The upload part size is invalid' }, 400);
  }

  try {
    const multipart = env.ARTWORK_BUCKET.resumeMultipartUpload(getProductPdfKey(productCode), uploadId);
    const uploaded = await multipart.uploadPart(partNumber, bytes);
    return jsonResponse(request, env, {
      success:true,
      partNumber:uploaded.partNumber,
      etag:uploaded.etag
    });
  } catch (error) {
    console.error('Tiny Frame multipart part upload failed', {
      productCode,
      partNumber,
      errorName:String(error?.name || 'Error')
    });
    return jsonResponse(request, env, {
      error:'This part of the print sheet could not be uploaded. Please retry.',
      code:'MULTIPART_PART_FAILED'
    }, 503);
  }
}

async function completeTinyFrameProductPdfMultipart(request, env) {
  if (!env.PRODUCT_CODES_DB || !env.ARTWORK_BUCKET) {
    return jsonResponse(request, env, { error:'Product storage is not configured' }, 503);
  }
  if (!getAllowedOrigin(request, env)) {
    return jsonResponse(request, env, { error:'Origin is not allowed' }, 403);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, env, { error:'Request body must be valid JSON' }, 400);
  }
  const cartItemId = normalizeCartItemId(body?.cartItemId);
  const productCode = normalizeProductCode(body?.productCode);
  const uploadId = normalizeMultipartUploadId(body?.uploadId);
  const fileSize = normalizeMultipartPdfSize(body?.fileSize);
  const partCount = fileSize ? Math.ceil(fileSize / TINY_FRAME_PDF_PART_BYTES) : 0;
  const parts = Array.isArray(body?.parts) ? body.parts.map((part) => ({
    partNumber:Number(part?.partNumber),
    etag:String(part?.etag || '')
  })) : [];
  const validParts = parts.length === partCount && partCount > 0 && partCount <= MAX_TINY_FRAME_PDF_PARTS &&
    parts.every((part, index) => (
      part.partNumber === index + 1 && part.etag.length > 0 && part.etag.length <= 256 &&
      !/[\u0000-\u001f\u007f]/.test(part.etag)
    ));
  if (!cartItemId || !productCode || !uploadId || !fileSize || !validParts) {
    return jsonResponse(request, env, { error:'Multipart completion details are invalid' }, 400);
  }

  const diagnosticId = crypto.randomUUID().slice(0, 8);
  const objectKey = getProductPdfKey(productCode);
  try {
    const record = await findProductCode(env.PRODUCT_CODES_DB, productCode);
    if (!record || record.cart_item_id !== cartItemId || !['tiny_frame_8_pictures', 'tiny_frame_photo_sets'].includes(record.product_type)) {
      return jsonResponse(request, env, { error:'This multipart upload does not belong to the cart product' }, 403);
    }
    const recovered = await getCompletedProductPdf(env, { cartItemId, productCode, fileSize });
    if (recovered) return jsonResponse(request, env, recovered);

    const multipart = env.ARTWORK_BUCKET.resumeMultipartUpload(objectKey, uploadId);
    await multipart.complete(parts);
    const completed = await getCompletedProductPdf(env, { cartItemId, productCode, fileSize });
    if (!completed) throw new TinyFrameInputError('The uploaded print sheet could not be found');
    return jsonResponse(request, env, { ...completed, retry_recovered:false });
  } catch (error) {
    const expected = error instanceof TinyFrameInputError || error instanceof ProductCodeError;
    console.error('Tiny Frame multipart completion failed', {
      diagnosticId,
      productCode,
      errorName:String(error?.name || 'Error')
    });
    return jsonResponse(request, env, {
      error:expected ? error.message : 'The print sheet could not be completed. Your pictures are still selected, so please try again.',
      code:String(error?.code || (expected ? 'INVALID_PRINT_SHEET' : 'MULTIPART_COMPLETE_FAILED')),
      diagnostic_id:diagnosticId
    }, expected ? 400 : 503);
  }
}

async function getTinyFrameProductPdfStatus(request, env) {
  if (!env.PRODUCT_CODES_DB || !env.ARTWORK_BUCKET) {
    return jsonResponse(request, env, { error:'Product storage is not configured' }, 503);
  }
  if (!getAllowedOrigin(request, env)) {
    return jsonResponse(request, env, { error:'Origin is not allowed' }, 403);
  }
  const url = new URL(request.url);
  const cartItemId = normalizeCartItemId(url.searchParams.get('cart_item_id'));
  const productCode = normalizeProductCode(url.searchParams.get('product_code'));
  if (!cartItemId || !productCode) {
    return jsonResponse(request, env, { error:'Cart identity and product code are required' }, 400);
  }
  try {
    const record = await findProductCode(env.PRODUCT_CODES_DB, productCode);
    const objectKey = getProductPdfKey(productCode);
    if (
      !record ||
      record.cart_item_id !== cartItemId ||
      !['tiny_frame_8_pictures', 'tiny_frame_photo_sets'].includes(record.product_type) ||
      record.upload_session_id !== objectKey
    ) {
      return jsonResponse(request, env, { error:'The print sheet has not finished uploading', code:'PDF_NOT_READY' }, 404);
    }
    const stored = await env.ARTWORK_BUCKET.head(objectKey);
    const size = Number(stored?.size || stored?.contentLength || 0);
    if (
      !stored ||
      size < 1 ||
      stored.customMetadata?.product_code !== productCode ||
      stored.customMetadata?.cart_item_id !== cartItemId
    ) {
      return jsonResponse(request, env, { error:'The print sheet has not finished uploading', code:'PDF_NOT_READY' }, 404);
    }
    return jsonResponse(request, env, {
      success:true,
      recovered:true,
      productCode,
      pdf:{ filename:`${productCode}-print-sheet.pdf`, objectKey, size }
    });
  } catch (error) {
    console.error('Tiny Frame PDF status check failed', {
      productCode,
      errorName:String(error?.name || 'Error')
    });
    return jsonResponse(request, env, {
      error:'The print-sheet upload could not be verified yet',
      code:'PDF_STATUS_FAILED'
    }, 503);
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

function normalizeFrameColour(value) {
  const colour = cleanText(value, '').toLowerCase();
  if (colour === 'oak') return 'Oak';
  if (colour === 'walnut') return 'Walnut';
  return '';
}

function normalizeUploadReference(value) {
  const reference = cleanText(value, '').toLowerCase();
  return /^tf_[a-f0-9]{32}$/.test(reference) ? reference : '';
}

function normalizePictureUploadReference(value) {
  const reference = cleanText(value, '');
  return normalizeUploadReference(reference) || (isValidProductPdfKey(reference) ? reference : '');
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
    if (tinyFrameProduct && !frameColour) {
      throw new Error('One or more Tiny Frames has an invalid frame colour');
    }
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
      const artwork = item.productType === 'tiny_frame_8_pictures' || isValidProductPdfKey(item.uploadReference)
        ? ` | PDF ${getProductPdfKey(item.productCode)}`
        : item.photoCount > 0
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

async function loadProcessedImagesForManifest(manifest, env) {
  const storedProcessed = Array.isArray(manifest.processed_images) ? manifest.processed_images : [];
  if (
    storedProcessed.length === TINY_FRAME_UPLOAD_IMAGE_COUNT &&
    storedProcessed.every(file => isValidProcessedImageKey(file?.objectKey))
  ) {
    const images = [];
    for (const file of storedProcessed) {
      const object = await env.ARTWORK_BUCKET.get(file.objectKey);
      if (!object) throw new Error('A processed print image could not be found');
      images.push({ bytes:new Uint8Array(await new Response(object.body).arrayBuffer()) });
    }
    return images;
  }

  const originals = Array.isArray(manifest.originals) ? manifest.originals : [];
  if (originals.length !== TINY_FRAME_UPLOAD_IMAGE_COUNT || !env.IMAGES) {
    throw new Error('This picture upload must be added to the cart again before checkout');
  }
  const images = [];
  for (const [index, original] of originals.entries()) {
    const object = await env.ARTWORK_BUCKET.get(String(original?.objectKey || ''));
    if (!object) throw new Error(`Original picture ${index + 1} could not be found`);
    const crop = normalizeTinyFrameCrop({
      ...original.crop,
      sourceWidth:original.width_px,
      sourceHeight:original.height_px
    }, index);
    const sourceBytes = await new Response(object.body).arrayBuffer();
    images.push({ bytes:await transformOriginalForPrint(env, sourceBytes, crop) });
  }
  return images;
}

async function addProductCodesToStoredFileMetadata(files, productCodes, env) {
  const productCodeValue = productCodes.join(',');
  for (const file of files) {
    const objectKey = String(file?.objectKey || '');
    if (!objectKey) continue;
    const object = await env.ARTWORK_BUCKET.get(objectKey);
    if (!object) throw new Error(`Stored artwork ${objectKey} could not be found`);
    await env.ARTWORK_BUCKET.put(objectKey, object.body, {
      httpMetadata:{ contentType:String(file.contentType || 'application/octet-stream') },
      customMetadata:{
        ...(object.customMetadata || {}),
        product_codes:productCodeValue
      }
    });
  }
}

async function ensureProductCodePrintSheets(uploadReference, productCodes, env) {
  const sessionRecord = await getPhotoUploadSession(env.PRODUCT_CODES_DB, uploadReference);
  const storageFolder = getPhotoUploadStorageFolder(sessionRecord, uploadReference);
  let manifestKey = getUploadManifestKey(uploadReference, storageFolder);
  let object = await env.ARTWORK_BUCKET.get(manifestKey);
  if (!object) {
    manifestKey = getLegacyIndividualUploadManifestKey(uploadReference);
    object = await env.ARTWORK_BUCKET.get(manifestKey);
  }
  if (!object) {
    if (await env.ARTWORK_BUCKET.head(getLegacyUploadManifestKey(uploadReference))) {
      throw new Error('This legacy picture upload must be added to the cart again before checkout');
    }
    throw new Error('One or more picture uploads could not be verified');
  }
  const manifest = await readR2Json(object);
  if (!manifest) throw new Error('A picture upload manifest is invalid');

  const normalizedCodes = productCodes.map(normalizeProductCode);
  if (normalizedCodes.some(code => !code) || new Set(normalizedCodes).size !== normalizedCodes.length) {
    throw new Error('Picture product codes are invalid');
  }
  const existingSheets = new Map(
    (Array.isArray(manifest.print_sheets) ? manifest.print_sheets : [])
      .filter(sheet => normalizeProductCode(sheet?.product_code) && (
        isValidTinyFramePrintSheetKey(sheet?.objectKey) || isValidProductPdfKey(sheet?.objectKey, sheet?.product_code)
      ))
      .map(sheet => [sheet.product_code, sheet])
  );
  const missingCodes = normalizedCodes.filter(code => !existingSheets.has(code));
  const processedImages = missingCodes.length ? await loadProcessedImagesForManifest(manifest, env) : [];
  const generatedSheets = [];
  for (const productCode of missingCodes) {
    const filename = `${productCode}-print-sheet.pdf`;
    const objectKey = getProductPdfKey(productCode);
    const pdfBytes = createA4PrintSheetPdf(processedImages, { productCode });
    if (pdfBytes.length > MAX_TINY_FRAME_PDF_BYTES) {
      throw new Error('The generated PDF exceeds the 95 MB upload limit');
    }
    const pdfInspection = inspectPrintSheetPdf(pdfBytes);
    if (!pdfInspection.valid) throw new Error(pdfInspection.error);
    await env.ARTWORK_BUCKET.put(objectKey, pdfBytes, {
      httpMetadata:{ contentType:'application/pdf' },
      customMetadata:{
        upload_session_id:uploadReference,
        product_code:productCode,
        product_type:'frame_8_pictures',
        frame_colour:String(manifest.frame_colour || '').toLowerCase(),
        image_count:String(TINY_FRAME_UPLOAD_IMAGE_COUNT),
        photo_width_mm:'54',
        photo_height_mm:'86',
        status:'pending',
        created_at:new Date().toISOString()
      },
      onlyIf:{ etagDoesNotMatch:'*' }
    });
    const sheet = {
      product_code:productCode,
      filename,
      objectKey,
      contentType:'application/pdf',
      size:pdfBytes.length
    };
    existingSheets.set(productCode, sheet);
    generatedSheets.push(sheet);
  }

  const filesToTag = [
    ...(Array.isArray(manifest.originals) ? manifest.originals : []),
    ...(Array.isArray(manifest.processed_images) ? manifest.processed_images : [])
  ];
  await addProductCodesToStoredFileMetadata(filesToTag, normalizedCodes, env);
  const printSheets = normalizedCodes.map(code => existingSheets.get(code));
  const generatedAt = new Date().toISOString();
  const updatedManifest = {
    ...manifest,
    product_codes:normalizedCodes,
    print_sheets:printSheets,
    files:[
      ...(Array.isArray(manifest.files)
        ? manifest.files.filter(file => !/^(?:print-sheet-[1-9][0-9]{4}|[1-9][0-9]{4}-print-sheet)\.pdf$/.test(String(file?.filename || '')))
        : []),
      ...printSheets
    ],
    product_codes_assigned_at:manifest.product_codes_assigned_at || generatedAt,
    updated_at:generatedAt
  };
  await env.ARTWORK_BUCKET.put(manifestKey, JSON.stringify(updatedManifest), {
    httpMetadata:{ contentType:'application/json' }
  });
  return generatedSheets.length;
}

async function verifyUploadManifests(lineItems, env) {
  const pictureItems = lineItems.filter(item => item.productType === 'tiny_frame_8_pictures' || (item.productType === 'tiny_frame_photo_sets' && item.photoCount > 0));
  if (!pictureItems.length) return;
  if (!env.ARTWORK_BUCKET) throw new Error('Artwork storage is not configured');
  const codesByUpload = new Map();
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
          !['finalized', 'checkout_pending'].includes(record.status) ||
          snapshot?.upload_session_id !== uploadSessionId ||
          snapshot.cart_item_id !== item.cartItemId ||
          snapshot.frame_colour !== item.frameColour ||
          Number(snapshot.photo_set_count) !== item.photoSetCount ||
          Number(snapshot.photo_count) !== item.photoCount ||
          photos.length !== item.photoCount
        ) throw new Error('The current selected-photo snapshot could not be verified');
        const storedPhotos = await Promise.all(photos.map(photo => env.ARTWORK_BUCKET.head(String(photo?.objectKey || ''))));
        if (storedPhotos.some((photo, index) =>
          !photo ||
          !isValidIndividualPhotoKey(photos[index]?.objectKey, uploadSessionId, storageFolder) ||
          photo.customMetadata?.upload_session_id !== uploadSessionId ||
          photo.customMetadata?.photo_id !== photos[index]?.photo_id ||
          photo.customMetadata?.revision !== photos[index]?.revision
        )) throw new Error('One or more selected photos could not be verified in temporary storage');
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
          manifest.frame_colour !== item.frameColour || Number(manifest.photo_set_count) !== item.photoSetCount ||
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
    if (isValidProductPdfKey(item.uploadReference)) {
      if (!isValidProductPdfKey(item.uploadReference, item.productCode)) {
        throw new Error('The uploaded PDF does not match its product code');
      }
      const object = await env.ARTWORK_BUCKET.head(item.uploadReference);
      if (
        !object ||
        object.customMetadata?.product_code !== item.productCode ||
        object.customMetadata?.cart_item_id !== item.cartItemId ||
        object.customMetadata?.product_type !== item.productType ||
        Number(object.customMetadata?.image_count || 0) !== item.photoCount ||
        (item.productType === 'tiny_frame_photo_sets' && Number(object.customMetadata?.photo_set_count || 0) !== item.photoSetCount)
      ) {
        throw new Error('One or more print-sheet PDFs could not be verified');
      }
      continue;
    }
    if (item.productType === 'tiny_frame_photo_sets') throw new Error('Variable photo sets require completed individual photo uploads');
    const codes = codesByUpload.get(item.uploadReference) || [];
    codes.push(item.productCode);
    codesByUpload.set(item.uploadReference, codes);
  }
  for (const [uploadReference, productCodes] of codesByUpload) {
    await ensureProductCodePrintSheets(uploadReference, productCodes, env);
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

async function markProductPdfFilesPaid(session, env) {
  if (!env.ARTWORK_BUCKET) throw new Error('Artwork storage is not configured');
  const stripeCheckoutSessionId = cleanText(session?.id, '');
  const productCodes = getCheckoutProductCodes(session);
  const paidAt = new Date().toISOString();
  let updated = 0;
  for (const productCode of productCodes) {
    for (const objectKey of getProductPdfKeyCandidates(productCode)) {
      const object = await env.ARTWORK_BUCKET.get(objectKey);
      if (!object) continue;
      await env.ARTWORK_BUCKET.put(objectKey, object.body, {
        httpMetadata:{ contentType:'application/pdf' },
        customMetadata:{
          ...(object.customMetadata || {}),
          status:'paid',
          paid_at:paidAt,
          ...(stripeCheckoutSessionId ? { stripe_checkout_session_id:stripeCheckoutSessionId } : {})
        }
      });
      updated += 1;
      break;
    }
  }
  return updated;
}

async function putPaidPhotoOnce(bucket, finalKey, source, productCode, stripeCheckoutSessionId, paidAt) {
  const sourceMetadata = source.customMetadata || {};
  const requiredMetadata = {
    upload_session_id:String(sourceMetadata.upload_session_id || ''),
    photo_id:String(sourceMetadata.photo_id || ''),
    revision:String(sourceMetadata.revision || ''),
    product_code:productCode,
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
    existing?.product_code !== manifest.product_code ||
    existing?.status !== 'paid' ||
    !samePhotos
  ) throw new Error(`Refusing to replace a different paid-order manifest at ${manifestKey}`);
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
      const productCodes = (Array.isArray(parsePhotoUploadJson(record?.product_codes_json, []))
        ? parsePhotoUploadJson(record.product_codes_json, [])
        : []).map(normalizeProductCode).filter(Boolean);
      if (
        !record || !snapshot || record.cart_item_id !== snapshot.cart_item_id ||
        !['checkout_pending', 'paid'].includes(record.status) ||
        (record.stripe_checkout_session_id && record.stripe_checkout_session_id !== stripeCheckoutSessionId) ||
        !stripeCheckoutSessionId || !productCodes.length ||
        !Array.isArray(snapshot.photos) || snapshot.photos.length !== Number(snapshot.photo_count)
      ) throw new Error(`Upload session ${uploadSessionId} is missing its verified paid-order snapshot`);
      const paidAt = manifest.paid_at || new Date().toISOString();
      const finalProducts = [];
      for (const productCode of productCodes) {
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
          const finalKey = `orders/${stripeCheckoutSessionId}/${productCode}/photo-${String(position).padStart(3, '0')}.jpg`;
          await putPaidPhotoOnce(env.ARTWORK_BUCKET, finalKey, source, productCode, stripeCheckoutSessionId, paidAt);
          finalPhotos.push({
            photo_id:photo.photo_id,
            revision:photo.revision,
            position,
            objectKey:finalKey,
            contentType:'image/jpeg'
          });
        }
        const finalManifestKey = `orders/${stripeCheckoutSessionId}/${productCode}/manifest.json`;
        const finalManifest = {
          storage_version:INDIVIDUAL_PHOTO_STORAGE_VERSION,
          stripe_checkout_session_id:stripeCheckoutSessionId,
          product_code:productCode,
          cart_item_id:snapshot.cart_item_id,
          frame_colour:snapshot.frame_colour,
          product_type:snapshot.product_type,
          photo_set_count:snapshot.photo_set_count,
          photo_count:snapshot.photo_count,
          selected_photo_order:finalPhotos.map(photo => photo.photo_id),
          photos:finalPhotos,
          status:'paid',
          paid_at:paidAt
        };
        await putPaidManifestOnce(env.ARTWORK_BUCKET, finalManifestKey, finalManifest);
        finalProducts.push({ product_code:productCode, manifest_key:finalManifestKey, photos:finalPhotos });
      }
      await env.PRODUCT_CODES_DB.prepare(
        `UPDATE photo_upload_sessions
            SET status = 'paid',
                state_version = state_version + 1,
                updated_at = ?
          WHERE upload_session_id = ?
            AND stripe_checkout_session_id = ?
            AND status IN ('checkout_pending', 'paid')`
      ).bind(paidAt, uploadSessionId, stripeCheckoutSessionId).run();
      await env.ARTWORK_BUCKET.put(manifestKey, JSON.stringify({
        ...manifest,
        ...snapshot,
        product_codes:productCodes,
        status:'paid',
        stripe_checkout_session_id:stripeCheckoutSessionId,
        paid_at:paidAt,
        final_products:finalProducts
      }), { httpMetadata:{ contentType:'application/json' } });
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
      const finalProducts = [];
      for (const productCode of productCodes) {
        const finalPhotos = [];
        for (const photo of photos) {
          const sourceKey = String(photo?.objectKey || '');
          const source = await env.ARTWORK_BUCKET.get(sourceKey);
          if (!source || !isValidIndividualPhotoKey(sourceKey, uploadSessionId)) {
            throw new Error(`Stored artwork for ${uploadSessionId} could not be found`);
          }
          const finalKey = `orders/${stripeCheckoutSessionId}/product-${productCode}/photo-${String(photo.position).padStart(3, '0')}.jpg`;
          await putPaidPhotoOnce(env.ARTWORK_BUCKET, finalKey, source, productCode, stripeCheckoutSessionId, paidAt);
          finalPhotos.push({ position:photo.position, objectKey:finalKey, contentType:'image/jpeg' });
        }
        const finalManifestKey = `orders/${stripeCheckoutSessionId}/product-${productCode}/manifest.json`;
        await putPaidManifestOnce(env.ARTWORK_BUCKET, finalManifestKey, {
          storage_version:INDIVIDUAL_PHOTO_STORAGE_VERSION,
          stripe_checkout_session_id:stripeCheckoutSessionId,
          product_code:productCode,
          cart_item_id:manifest.cart_item_id,
          frame_colour:manifest.frame_colour,
          product_type:manifest.product_type,
          photo_count:manifest.photo_count,
          photo_set_count:manifest.photo_set_count,
          photos:finalPhotos,
          status:'paid',
          paid_at:paidAt
        });
        finalProducts.push({ product_code:productCode, manifest_key:finalManifestKey, photos:finalPhotos });
      }
      await env.ARTWORK_BUCKET.put(manifestKey, JSON.stringify({
        ...manifest,
        status:'paid',
        stripe_checkout_session_id:stripeCheckoutSessionId,
        paid_at:paidAt,
        final_products:finalProducts
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
      ...(manifest.print_sheet_object_key ? [{ objectKey:manifest.print_sheet_object_key, contentType:'application/pdf' }] : []),
      ...(Array.isArray(manifest.print_sheets) ? manifest.print_sheets : []),
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
              updated_at, storage_folder
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
      await markProductPdfFilesPaid(completedSession, env);
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
    const checkoutSessionId = cleanText(record.stripe_checkout_session_id, '');
    if (checkoutSessionId) {
      const manifestKeys = [
        `orders/${checkoutSessionId}/${normalizedCode}/manifest.json`,
        `orders/${checkoutSessionId}/product-${normalizedCode}/manifest.json`
      ];
      let manifest = null;
      for (const manifestKey of manifestKeys) {
        const object = await env.ARTWORK_BUCKET.get(manifestKey);
        manifest = object ? await readR2Json(object) : null;
        if (manifest) break;
      }
      if ([LEGACY_INDIVIDUAL_PHOTO_STORAGE_VERSION, INDIVIDUAL_PHOTO_STORAGE_VERSION].includes(Number(manifest?.storage_version))) {
        const photos = (Array.isArray(manifest.photos) ? manifest.photos : []).map((photo, index) => ({
          position:Number(photo.position || index + 1),
          filename:`${normalizedCode}-photo-${String(photo.position || index + 1).padStart(3, '0')}.jpg`,
          downloadUrl:`/admin/product-assets/${normalizedCode}/photo/${Number(photo.position || index + 1)}`
        }));
        return jsonResponse(request, env, {
          productCode:normalizedCode,
          status:record.status,
          frameColour:manifest.frame_colour || record.frame_colour,
          photoSetCount:Number(manifest.photo_set_count || 0),
          photoCount:photos.length,
          photos,
          legacyPdf:null
        });
      }
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
    const checkoutSessionId = cleanText(record.stripe_checkout_session_id, '');
    if (!checkoutSessionId || !Number.isSafeInteger(photoPosition) || photoPosition < 1) {
      return jsonResponse(request, env, { error:'Photo reference is invalid' }, 400);
    }
    let manifest = null;
    let expectedPrefix = '';
    for (const folder of [normalizedCode, `product-${normalizedCode}`]) {
      expectedPrefix = `orders/${checkoutSessionId}/${folder}/`;
      const manifestObject = await env.ARTWORK_BUCKET.get(`${expectedPrefix}manifest.json`);
      manifest = manifestObject ? await readR2Json(manifestObject) : null;
      if (manifest) break;
    }
    const photo = Array.isArray(manifest?.photos) ? manifest.photos.find(item => Number(item?.position) === photoPosition) : null;
    if (!photo || !String(photo.objectKey || '').startsWith(expectedPrefix)) {
      return jsonResponse(request, env, { error:'Photo was not found' }, 404);
    }
    objectKey = String(photo.objectKey);
    contentType = 'image/jpeg';
    filename = `${normalizedCode}-photo-${String(photoPosition).padStart(3, '0')}.jpg`;
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
  markProductPdfFilesPaid,
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

    if (request.method === 'POST' && url.pathname === '/tiny-frame-pdf/reserve') {
      return reserveTinyFrameProductPdf(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/product-code/assign') {
      return reserveTinyFrameProductPdf(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/tiny-frame-pdf/upload') {
      return uploadTinyFrameProductPdf(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/tiny-frame-pdf/multipart/create') {
      return createTinyFrameProductPdfMultipart(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/tiny-frame-pdf/multipart/part') {
      return uploadTinyFrameProductPdfPart(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/tiny-frame-pdf/multipart/complete') {
      return completeTinyFrameProductPdfMultipart(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/tiny-frame-pdf/status') {
      return getTinyFrameProductPdfStatus(request, env);
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
