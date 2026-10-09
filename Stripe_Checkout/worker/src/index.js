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
  findProductCode,
  getProductCodeCapacity,
  markProductCodesPaid,
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
  tiny_frame_only: Object.freeze({
    orderType: 'frame-only',
    name: 'Tiny Frame - Frame Only',
    unitAmount: 7000,
    requiresPictures: false
  }),
  tiny_frame_8_pictures: Object.freeze({
    orderType: 'frame-plus-pictures',
    name: 'Tiny Frame + 8 Pictures',
    unitAmount: 9000,
    requiresPictures: true
  })
});
const SHIPPING_AMOUNT = 1000;
const TINY_FRAME_UPLOAD_PREFIX = 'tinyframes/';
const TINY_FRAME_UPLOAD_IMAGE_COUNT = 8;
const MAX_TINY_FRAME_ORIGINAL_BYTES = 20 * 1024 * 1024;
const MAX_TINY_FRAME_UPLOAD_BYTES = 96 * 1024 * 1024;
// Keep the multipart request safely below Cloudflare's 100 MB request limit.
const MAX_TINY_FRAME_PDF_BYTES = 95 * 1024 * 1024;
const A4_WIDTH_POINTS = 595.275591;
const A4_HEIGHT_POINTS = 841.889764;
const TINY_FRAME_PHOTO_WIDTH_POINTS = 54 * 72 / 25.4;
const TINY_FRAME_PHOTO_HEIGHT_POINTS = 86 * 72 / 25.4;
const TINY_FRAME_PHOTO_WIDTH_INCHES = 54 / 25.4;
const TINY_FRAME_PHOTO_HEIGHT_INCHES = 86 / 25.4;
const TINY_FRAME_LOW_RESOLUTION_PPI = 200;
const SUPPORTED_TINY_FRAME_IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/gif']);
const DEFAULT_PENDING_UPLOAD_TTL_DAYS = 10;

class TinyFrameInputError extends Error {}
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
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  });
  const allowedOrigin = getAllowedOrigin(request, env);

  if (allowedOrigin) {
    headers.set('Access-Control-Allow-Origin', allowedOrigin);
    headers.set('Vary', 'Origin');
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

function getTinyFrameUploadPrefix(uploadSessionId) {
  return `${TINY_FRAME_UPLOAD_PREFIX}${uploadSessionId}/`;
}

function getUploadManifestKey(uploadSessionId) {
  return `${getTinyFrameUploadPrefix(uploadSessionId)}manifest.json`;
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

function inspectPrintSheetPdf(bytes, expectedProductCode = '') {
  if (!(bytes instanceof Uint8Array) || bytes.length < 5) {
    return { valid:false, error:'The print sheet is not a PDF' };
  }
  const structuralPrefix = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024)));
  if (!structuralPrefix.startsWith('%PDF-')) return { valid:false, error:'The print sheet is not a PDF' };
  const mediaBox = `/MediaBox [0 0 ${pdfNumber(A4_WIDTH_POINTS)} ${pdfNumber(A4_HEIGHT_POINTS)}]`;
  if (!structuralPrefix.includes(mediaBox)) {
    return { valid:false, error:'The print sheet must be an exact portrait A4 page' };
  }
  if (countAscii(bytes, '/Subtype /Image') !== TINY_FRAME_UPLOAD_IMAGE_COUNT) {
    return { valid:false, error:'The print sheet must contain exactly 8 embedded pictures' };
  }
  const placements = getA4PrintLayout();
  for (const [index, placement] of placements.entries()) {
    const command = `q ${pdfNumber(TINY_FRAME_PHOTO_WIDTH_POINTS)} 0 0 ${pdfNumber(TINY_FRAME_PHOTO_HEIGHT_POINTS)} ${pdfNumber(placement.xMm * 72 / 25.4)} ${pdfNumber(placement.yMm * 72 / 25.4)} cm /Im${index + 1} Do Q`;
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
    return jsonResponse(request, env, { error:'Pictures must be JPEG, PNG, or GIF files' }, 400);
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
        : 'We could not prepare your pictures. Your uploaded originals are safe, so please try again.',
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
    return jsonResponse(request, env, { error: 'Pictures must be JPEG, PNG, or GIF files' }, 400);
  }
  if (originals.some(file => !file.size || file.size > MAX_TINY_FRAME_ORIGINAL_BYTES)) {
    return jsonResponse(request, env, { error: 'Each original picture must be 20 MB or smaller' }, 413);
  }
  if (originals.reduce((sum, file) => sum + file.size, 0) > MAX_TINY_FRAME_UPLOAD_BYTES) {
    return jsonResponse(request, env, { error: 'The combined original pictures exceed the 96 MB upload limit' }, 413);
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
      throw new Error('The generated PDF exceeds the 160 MB storage limit');
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
      error:'We could not prepare your pictures. Your selections are still here, so please try again.',
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
  if (!cartItemId || !frameColour) {
    return jsonResponse(request, env, { error:'Cart product identity or frame colour is invalid' }, 400);
  }
  try {
    const reservation = await reserveCartProductCode(env.PRODUCT_CODES_DB, {
      cartItemId,
      productType
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
  const pdf = formData.get('pdf');
  if (!cartItemId || !pdf || typeof pdf.arrayBuffer !== 'function') {
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
    return jsonResponse(request, env, { error:'The print-sheet PDF is empty or exceeds the storage limit' }, 413);
  }

  const diagnosticId = crypto.randomUUID().slice(0, 8);
  try {
    const reservation = await reserveCartProductCode(env.PRODUCT_CODES_DB, {
      cartItemId,
      productType:'tiny_frame_8_pictures'
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
    const inspection = inspectPrintSheetPdf(bytes, requestedProductCode ? productCode : '');
    if (!inspection.valid) throw new TinyFrameInputError(inspection.error);
    const createdAt = new Date().toISOString();
    const stored = await env.ARTWORK_BUCKET.put(objectKey, bytes, {
      httpMetadata:{ contentType:'application/pdf' },
      customMetadata:{
        product_code:productCode,
        cart_item_id:cartItemId,
        product_type:'tiny_frame_8_pictures',
        ...(frameColour ? { frame_colour:frameColour.toLowerCase() } : {}),
        image_count:String(TINY_FRAME_UPLOAD_IMAGE_COUNT),
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
      error:expected ? error.message : 'We could not store the print sheet. Your pictures are still selected, so please try again.',
      code:String(error?.code || (expected ? 'INVALID_PRINT_SHEET' : 'PDF_STORAGE_FAILED')),
      stage:expected ? 'pdf_validation' : 'pdf_storage',
      diagnostic_id:diagnosticId
    }, expected ? 400 : 500);
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
      return jsonResponse(request, env, { error: 'One or more uploaded pictures could not be found' }, 400);
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
  if (normalized === 'frame-only' || normalized === 'frame only') {
    return 'frame-only';
  }
  if (['frame-plus-pictures', 'frame + 8 pictures', 'frame plus 8 pictures'].includes(normalized)) {
    return 'frame-plus-pictures';
  }
  return '';
}

function normalizeTinyFrameProductType(item) {
  const explicitProductType = cleanText(item?.productType, '').toLowerCase();
  if (TINY_FRAME_PRODUCTS[explicitProductType]) {
    return explicitProductType;
  }
  const orderType = normalizeTinyFrameOrderType(item?.orderType);
  if (orderType === 'frame-only') return 'tiny_frame_only';
  if (orderType === 'frame-plus-pictures') return 'tiny_frame_8_pictures';
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
  return TINY_FRAME_PRODUCTS[productType]?.unitAmount;
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
    const unitAmount = getUnitAmount(item, size, productType);

    if (!unitAmount) {
      throw new Error(size === '80x80mm'
        ? 'One or more Tiny Frames has an invalid product type'
        : 'One or more cart items has an invalid frame size');
    }

    const requestedQuantity = Number(item.quantity);
    const quantity = Number.isInteger(requestedQuantity) && requestedQuantity >= 1 && requestedQuantity <= 10
      ? requestedQuantity
      : 1;
    const cartItemId = normalizeCartItemId(item.cartItemId || item.id);
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
    if (tinyFrameProduct?.requiresPictures && !uploadReference) {
      throw new Error('Frame + 8 Pictures requires a completed picture upload reference');
    }
    const description = [
      cleanText(item.orientation, ''),
      frameColour ? `${frameColour} Frame` : '',
      cleanText(item.border, ''),
      tinyFrameProduct?.orderType || cleanText(item.orderType, '')
    ].filter(Boolean).join(' | ') || 'Custom framed print';

    for (let unitIndex = 0; unitIndex < quantity; unitIndex += 1) {
      lineItems.push({
        name: tinyFrameProduct?.name || `Print & Frame - ${size}`,
        description,
        unitAmount,
        quantity:1,
        cartItemId,
        unitIndex,
        productType:productType || 'print_frame',
        frameColour,
        uploadReference,
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

  lineItems.push({
    name: 'Shipping',
    description: 'Standard shipping',
    unitAmount: SHIPPING_AMOUNT,
    quantity: 1
  });

  return lineItems;
}

function createStripePayload(lineItems, siteBaseUrl, stripeMode = 'live', checkoutRequestId = '') {
  const productCodes = lineItems.map(item => item.productCode).filter(Boolean);
  const productTypes = lineItems.map(item => item.productType).filter(Boolean);
  const frameColours = lineItems.map(item => item.frameColour).filter(Boolean);
  const uploadReferences = [...new Set(lineItems.map(item => item.uploadReference).filter(Boolean))];
  const payload = new URLSearchParams({
    mode: 'payment',
    success_url: `${siteBaseUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteBaseUrl}/?checkout=cancelled#cart`,
    billing_address_collection: 'required',
    'shipping_address_collection[allowed_countries][0]': 'AU',
    'shipping_address_collection[allowed_countries][1]': 'US',
    'shipping_address_collection[allowed_countries][2]': 'BR'
  });

  payload.set('metadata[stripe_mode]', stripeMode);
  payload.set('payment_intent_data[metadata][stripe_mode]', stripeMode);
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
  }
  if (uploadReferences.length > 0) {
    payload.set('metadata[upload_references]', uploadReferences.join(',').slice(0, 500));
    payload.set('payment_intent_data[metadata][upload_references]', uploadReferences.join(',').slice(0, 500));
    payload.set('metadata[upload_session_ids]', uploadReferences.join(',').slice(0, 500));
    payload.set('payment_intent_data[metadata][upload_session_ids]', uploadReferences.join(',').slice(0, 500));
  }

  lineItems.forEach((item, index) => {
    const prefix = `line_items[${index}]`;
    payload.set(`${prefix}[price_data][currency]`, 'aud');
    payload.set(
      `${prefix}[price_data][product_data][name]`,
      item.productCode ? `${item.name} · ${item.productCode}` : item.name
    );
    payload.set(`${prefix}[price_data][product_data][description]`, item.description);
    if (item.productType) {
      payload.set(`${prefix}[price_data][product_data][metadata][product_type]`, item.productType);
      payload.set(`${prefix}[price_data][product_data][metadata][frame_colour]`, item.frameColour);
      payload.set(`${prefix}[price_data][product_data][metadata][product_code]`, item.productCode);
      payload.set(`${prefix}[price_data][product_data][metadata][cart_item_id]`, item.cartItemId);
      payload.set(`${prefix}[price_data][product_data][metadata][unit_index]`, String(item.unitIndex));
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

function createCheckoutPayloadFingerprint(lineItems) {
  return JSON.stringify(lineItems.map(item => ({
    cartItemId:item.cartItemId || '',
    unitIndex:Number.isInteger(item.unitIndex) ? item.unitIndex : -1,
    productCode:item.productCode || '',
    productType:item.productType || '',
    size:item.size || '',
    frameColour:item.frameColour || '',
    uploadReference:item.uploadReference || '',
    unitAmount:item.unitAmount,
    quantity:item.quantity
  })));
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
  const manifestKey = getUploadManifestKey(uploadReference);
  const object = await env.ARTWORK_BUCKET.get(manifestKey);
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
  const pictureItems = lineItems.filter(item => item.productType === 'tiny_frame_8_pictures');
  if (!pictureItems.length) return;
  if (!env.ARTWORK_BUCKET) throw new Error('Artwork storage is not configured');
  const codesByUpload = new Map();
  for (const item of pictureItems) {
    if (isValidProductPdfKey(item.uploadReference)) {
      if (!isValidProductPdfKey(item.uploadReference, item.productCode)) {
        throw new Error('The uploaded PDF does not match its product code');
      }
      const object = await env.ARTWORK_BUCKET.head(item.uploadReference);
      if (!object || object.customMetadata?.product_code !== item.productCode || object.customMetadata?.cart_item_id !== item.cartItemId) {
        throw new Error('One or more print-sheet PDFs could not be verified');
      }
      continue;
    }
    const codes = codesByUpload.get(item.uploadReference) || [];
    codes.push(item.productCode);
    codesByUpload.set(item.uploadReference, codes);
  }
  for (const [uploadReference, productCodes] of codesByUpload) {
    await ensureProductCodePrintSheets(uploadReference, productCodes, env);
  }
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
    const physicalItems = lineItems.filter(item => item.cartItemId);
    const allocation = await reserveProductCodes(env.PRODUCT_CODES_DB, physicalItems, checkoutRequestId);
    capacity = allocation.capacity;
    let physicalIndex = 0;
    lineItems = lineItems.map(item => item.cartItemId ? allocation.units[physicalIndex++] : item);
    const payloadHash = await sha256Hex(createCheckoutPayloadFingerprint(lineItems));
    const checkoutRequest = await beginCheckoutRequest(
      env.PRODUCT_CODES_DB,
      checkoutRequestId,
      payloadHash,
      allocation.units.map(item => item.productCode)
    );
    if (checkoutRequest.stripe_checkout_session_id && checkoutRequest.stripe_checkout_url) {
      return jsonResponse(request, env, {
        id:checkoutRequest.stripe_checkout_session_id,
        url:checkoutRequest.stripe_checkout_url,
        stripeMode:stripeConfiguration.mode,
        productCodes:allocation.units.map(item => item.productCode)
      });
    }
    await verifyUploadManifests(lineItems, env);
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
    body: createStripePayload(lineItems, siteBaseUrl, stripeConfiguration.mode, checkoutRequestId)
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
    await completeCheckoutRequest(env.PRODUCT_CODES_DB, checkoutRequestId, stripeResult);
  } catch (error) {
    console.error('Checkout product identity persistence failed:', error);
    return jsonResponse(request, env, { error:'Checkout identity could not be stored safely' }, 503);
  }

  return jsonResponse(request, env, {
    id: stripeResult.id,
    url: stripeResult.url,
    stripeMode:stripeConfiguration.mode,
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
  const sessionId = new URL(request.url).searchParams.get('session_id') || '';
  const expectedSessionPrefix = stripeConfiguration.mode === 'live' ? 'cs_live_' : 'cs_test_';
  if (!sessionId.startsWith(expectedSessionPrefix) || !/^cs_(?:test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
    return jsonResponse(request, env, { error: 'Checkout session is invalid' }, 400);
  }

  const stripeResponse = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
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

  return jsonResponse(request, env, {
    status: stripeResult.status,
    paymentStatus: stripeResult.payment_status,
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
  const value = session?.metadata?.upload_session_ids || session?.metadata?.upload_references || '';
  return [...new Set(String(value).split(',').map(normalizeUploadReference).filter(Boolean))];
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

async function markUploadSessionsPaid(session, env) {
  if (!env.ARTWORK_BUCKET) throw new Error('Artwork storage is not configured');
  const uploadSessionIds = getCheckoutUploadSessionIds(session);
  const stripeCheckoutSessionId = cleanText(session?.id, '');
  for (const uploadSessionId of uploadSessionIds) {
    const currentKey = getUploadManifestKey(uploadSessionId);
    const legacyKey = getLegacyUploadManifestKey(uploadSessionId);
    let manifestKey = currentKey;
    let object = await env.ARTWORK_BUCKET.get(currentKey);
    if (!object) {
      manifestKey = legacyKey;
      object = await env.ARTWORK_BUCKET.get(legacyKey);
    }
    if (!object) throw new Error(`Upload session ${uploadSessionId} could not be found`);
    const manifest = await readR2Json(object);
    if (!manifest) throw new Error(`Upload session ${uploadSessionId} has an invalid manifest`);
    if (manifest.status === 'paid') continue;
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
  const ttlDays = Number.isFinite(configuredDays) && configuredDays >= 7 && configuredDays <= 14
    ? configuredDays
    : DEFAULT_PENDING_UPLOAD_TTL_DAYS;
  const cutoff = now - (ttlDays * 24 * 60 * 60 * 1000);
  let cursor;
  let deletedSessions = 0;

  do {
    const listing = await env.ARTWORK_BUCKET.list({
      prefix:TINY_FRAME_UPLOAD_PREFIX,
      ...(cursor ? { cursor } : {})
    });
    const manifests = listing.objects.filter(object => object.key.endsWith('/manifest.json'));
    for (const listedManifest of manifests) {
      const object = await env.ARTWORK_BUCKET.get(listedManifest.key);
      const manifest = await readR2Json(object);
      const uploadedAt = Date.parse(manifest?.uploaded_at || '');
      if (!manifest || manifest.status !== 'pending' || !Number.isFinite(uploadedAt) || uploadedAt >= cutoff) continue;
      const uploadSessionId = normalizeUploadReference(manifest.upload_session_id);
      if (!uploadSessionId) continue;
      const prefix = getTinyFrameUploadPrefix(uploadSessionId);
      const storedFileKeys = Array.isArray(manifest.files)
        ? manifest.files.map(file => String(file?.objectKey || '')).filter(key => key.startsWith(prefix))
        : [];
      await deleteObjectKeys(env.ARTWORK_BUCKET, [...new Set([...storedFileKeys, listedManifest.key])]);
      deletedSessions += 1;
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);

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

  if (event.type === 'checkout.session.completed') {
    try {
      await markProductCodesPaid(env.PRODUCT_CODES_DB, event.data.object);
      await markProductPdfFilesPaid(event.data.object, env);
      await markUploadSessionsPaid(event.data.object, env);
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
      await sendOrderConfirmationEmail(event.data.object, env);
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

async function getProductCodeCapacityRecord(request, env) {
  if (!env.PRODUCT_CODES_DB || !env.ADMIN_API_KEY) {
    return jsonResponse(request, env, { error:'Order management is not configured' }, 503);
  }
  if (!isAuthorizedAdminRequest(request, env)) {
    return jsonResponse(request, env, { error:'Unauthorized' }, 401);
  }
  return jsonResponse(request, env, await getProductCodeCapacity(env.PRODUCT_CODES_DB));
}

export {
  buildLineItems,
  claimWebhookEvent,
  cleanupPendingUploads,
  createStripePayload,
  markProductPdfFilesPaid,
  markUploadSessionsPaid,
  normalizeTinyFrameProductType,
  normalizeUploadReference
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
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

    if (request.method === 'GET' && url.pathname === '/admin/product-code-capacity') {
      return getProductCodeCapacityRecord(request, env);
    }

    if (request.method === 'GET' && url.pathname.startsWith('/admin/product-code/')) {
      return getProductCodeRecord(request, env, decodeURIComponent(url.pathname.slice('/admin/product-code/'.length)));
    }

    if (request.method === 'POST' && url.pathname === '/create-checkout-session') {
      return createCheckoutSession(request, env);
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
  },

  async scheduled(controller, env, context) {
    context.waitUntil(cleanupPendingUploads(env, controller.scheduledTime || Date.now()));
  }
};
