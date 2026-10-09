import {
  createOriginalObjectKey,
  createThumbnailObjectKey,
  isValidArtworkObjectKey,
  sanitizeUploadId
} from './r2-keys.js';
import {
  PRINT_SHEET_SPECIFICATION,
  createA4PrintSheetPdf,
  readJpegDimensions
} from './print-sheet-pdf.js';

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
const MAX_TINY_FRAME_PDF_BYTES = 160 * 1024 * 1024;
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
    'Access-Control-Allow-Headers': 'Content-Type',
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
  return /^tinyframes\/tf_[a-f0-9]{32}\/print-sheet-a4\.pdf$/.test(String(value || ''));
}

async function deleteObjectKeys(bucket, keys) {
  await Promise.allSettled(keys.map(key => bucket.delete(key)));
}

function inspectPrintSheetPdf(bytes) {
  const text = new TextDecoder('latin1').decode(bytes);
  if (!text.startsWith('%PDF-')) return { valid:false, error:'The print sheet is not a PDF' };
  const mediaBox = text.match(/\/MediaBox\s*\[\s*0(?:\.0+)?\s+0(?:\.0+)?\s+([\d.]+)\s+([\d.]+)\s*\]/);
  if (!mediaBox) return { valid:false, error:'The PDF page dimensions could not be verified' };
  const width = Number(mediaBox[1]);
  const height = Number(mediaBox[2]);
  if (Math.abs(width - A4_WIDTH_POINTS) > 0.01 || Math.abs(height - A4_HEIGHT_POINTS) > 0.01) {
    return { valid:false, error:'The print sheet must be an exact portrait A4 page' };
  }
  const embeddedImageCount = (text.match(/\/Subtype\s*\/Image\b/g) || []).length;
  if (embeddedImageCount !== TINY_FRAME_UPLOAD_IMAGE_COUNT) {
    return { valid:false, error:'The print sheet must contain exactly 8 embedded pictures' };
  }
  const placementPattern = /q\s+([\d.]+)\s+0\s+0\s+([\d.]+)\s+[\d.]+\s+[\d.]+\s+cm\s+\/Im\d+\s+Do\s+Q/g;
  const placements = [...text.matchAll(placementPattern)];
  if (placements.length !== TINY_FRAME_UPLOAD_IMAGE_COUNT) {
    return { valid:false, error:'The print-sheet picture placements could not be verified' };
  }
  if (placements.some(match => (
    Math.abs(Number(match[1]) - TINY_FRAME_PHOTO_WIDTH_POINTS) > 0.01 ||
    Math.abs(Number(match[2]) - TINY_FRAME_PHOTO_HEIGHT_POINTS) > 0.01
  ))) {
    return { valid:false, error:'Every print-sheet picture must be exactly 54 x 86 mm' };
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
  let transform = env.IMAGES
    .input(sourceBytes)
    .transform({
      trim:{ top:crop.top, left:crop.left, width:crop.width, height:crop.height },
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
  if (await env.ARTWORK_BUCKET.head(manifestKey)) {
    return jsonResponse(request, env, { error: 'Upload session already exists' }, 409);
  }

  const storedKeys = [];
  const printSheetFilename = 'print-sheet-a4.pdf';
  const printSheetObjectKey = `${getTinyFrameUploadPrefix(uploadSessionId)}${printSheetFilename}`;
  const createdAt = new Date().toISOString();
  try {
    const processedImages = [];
    const originalFiles = [];
    const imageQuality = [];

    for (let index = 0; index < originals.length; index += 1) {
      const file = originals[index];
      const sourceBuffer = await file.arrayBuffer();
      const sourceBytes = new Uint8Array(sourceBuffer);
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

      const processedBytes = await transformOriginalForPrint(env, sourceBuffer, submittedCrop);
      const processedDimensions = readJpegDimensions(processedBytes);
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

    const pdfBytes = createA4PrintSheetPdf(processedImages);
    if (pdfBytes.length > MAX_TINY_FRAME_PDF_BYTES) {
      throw new Error('The generated PDF exceeds the 160 MB storage limit');
    }
    const pdfInspection = inspectPrintSheetPdf(pdfBytes);
    if (!pdfInspection.valid) throw new Error(pdfInspection.error);

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
      files:[{
        filename:printSheetFilename,
        objectKey:printSheetObjectKey,
        contentType:'application/pdf',
        size:pdfBytes.length
      }, ...originalFiles],
      status:'pending',
      created_at:createdAt,
      generated_at:createdAt,
      uploaded_at:createdAt
    };
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
      return jsonResponse(request, env, { error:error.message }, 400);
    }
    console.error('Tiny Frame print-sheet upload failed:', error);
    return jsonResponse(request, env, { error:'The print sheet could not be stored. Please try again.' }, 500);
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

function getOrderCode(item) {
  const values = [
    item?.uniqueCode,
    item?.orderCode,
    item?.code,
    item?.productName,
    item?.internalTitle,
    getLegacyProductName(item)
  ];

  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number') {
      continue;
    }

    const match = String(value).match(/\b(\d{6})\b/);
    if (match) {
      return match[1];
    }
  }

  return '';
}

function getOrderCodes(lineItems) {
  return [...new Set(lineItems
    .map(item => item.orderCode)
    .filter(Boolean))];
}

function getOrderCodeMetadataValue(orderCodes) {
  return orderCodes.map(code => `#${code}`).join(', ').slice(0, 500);
}

function buildLineItems(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 10) {
    throw new Error('Cart must contain between 1 and 10 items');
  }

  const lineItems = [];

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
    const quantity = Number.isInteger(requestedQuantity)
      ? Math.min(Math.max(requestedQuantity, 1), 10)
      : 1;
    const orderCode = getOrderCode(item);
    const frameColour = normalizeFrameColour(item.frameColour || item.frameColor);
    const uploadReference = normalizeUploadReference(item.uploadReference || item.uploadId);
    const artworkObjectKeys = Array.isArray(item.artworkObjectKeys)
      ? item.artworkObjectKeys.filter(isValidArtworkObjectKey).slice(0, 8)
      : [];
    if (tinyFrameProduct && !frameColour) {
      throw new Error('One or more Tiny Frames has an invalid frame colour');
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

    lineItems.push({
      name: tinyFrameProduct?.name || `Print & Frame - ${size}`,
      description,
      unitAmount,
      quantity,
      orderCode,
      productType,
      frameColour,
      uploadReference,
      originalObjectKey: isValidArtworkObjectKey(item.originalObjectKey) ? item.originalObjectKey : '',
      thumbnailObjectKey: isValidArtworkObjectKey(item.thumbnailObjectKey) ? item.thumbnailObjectKey : '',
      artworkObjectKeys,
      size
    });
  });

  if (lineItems.length === 0) {
    throw new Error('Cart does not contain any purchasable items');
  }

  lineItems.push({
    name: 'Shipping',
    description: 'Standard shipping',
    unitAmount: SHIPPING_AMOUNT,
    quantity: 1
  });

  return lineItems;
}

function createStripePayload(lineItems, siteBaseUrl, stripeMode = 'live') {
  const orderCodes = getOrderCodes(lineItems);
  const orderCodeMetadataValue = getOrderCodeMetadataValue(orderCodes);
  const productTypes = lineItems.map(item => item.productType).filter(Boolean);
  const frameColours = lineItems.map(item => item.frameColour).filter(Boolean);
  const uploadReferences = lineItems.map(item => item.uploadReference).filter(Boolean);
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
  if (stripeMode === 'test') {
    payload.set(
      'custom_text[submit][message]',
      'TEST MODE — no real payment, fulfilment, shipping, or customer notification will occur.'
    );
  }

  if (orderCodes.length > 0) {
    payload.set('client_reference_id', orderCodes[0]);
    payload.set('metadata[order_codes]', orderCodeMetadataValue);
    payload.set('payment_intent_data[description]', 'Good Frame Order');
    payload.set('payment_intent_data[metadata][order_codes]', orderCodeMetadataValue);
  }
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
    payload.set(`${prefix}[price_data][product_data][name]`, item.name);
    payload.set(`${prefix}[price_data][product_data][description]`, item.description);
    if (item.productType) {
      payload.set(`${prefix}[price_data][product_data][metadata][product_type]`, item.productType);
      payload.set(`${prefix}[price_data][product_data][metadata][frame_colour]`, item.frameColour);
      payload.set(`${prefix}[price_data][product_data][metadata][quantity]`, String(item.quantity));
      if (item.uploadReference) {
        payload.set(`${prefix}[price_data][product_data][metadata][upload_reference]`, item.uploadReference);
        payload.set(`${prefix}[price_data][product_data][metadata][upload_session_id]`, item.uploadReference);
      }
    }
    if (item.orderCode) {
      payload.set(`${prefix}[price_data][product_data][metadata][order_code]`, item.orderCode);
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

async function verifyUploadManifests(lineItems, env) {
  const pictureItems = lineItems.filter(item => item.productType === 'tiny_frame_8_pictures');
  if (!pictureItems.length) return;
  if (!env.ARTWORK_BUCKET) {
    throw new Error('Artwork storage is not configured');
  }
  for (const item of pictureItems) {
    const currentManifest = await env.ARTWORK_BUCKET.head(getUploadManifestKey(item.uploadReference));
    const legacyManifest = currentManifest
      ? null
      : await env.ARTWORK_BUCKET.head(getLegacyUploadManifestKey(item.uploadReference));
    if (!currentManifest && !legacyManifest) {
      throw new Error('One or more picture uploads could not be verified');
    }
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

  let lineItems;
  try {
    lineItems = buildLineItems(body.items);
    await verifyUploadManifests(lineItems, env);
  } catch (error) {
    return jsonResponse(request, env, { error: error.message }, 400);
  }

  const siteBaseUrl = getSiteBaseUrl(env);
  if (!siteBaseUrl) {
    return jsonResponse(request, env, { error: 'Checkout is not configured' }, 503);
  }
  const stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeConfiguration.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: createStripePayload(lineItems, siteBaseUrl, stripeConfiguration.mode)
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

  return jsonResponse(request, env, {
    id: stripeResult.id,
    url: stripeResult.url,
    stripeMode:stripeConfiguration.mode
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
    const printSheetObjectKey = String(manifest.print_sheet_object_key || '');
    if (printSheetObjectKey) {
      const printSheet = await env.ARTWORK_BUCKET.get(printSheetObjectKey);
      if (!printSheet) throw new Error(`Print sheet for ${uploadSessionId} could not be found`);
      await env.ARTWORK_BUCKET.put(printSheetObjectKey, printSheet.body, {
        httpMetadata: { contentType:'application/pdf' },
        customMetadata: {
          ...(printSheet.customMetadata || {}),
          status:'paid',
          paid_at:paidAt,
          ...(stripeCheckoutSessionId ? { stripe_checkout_session_id:stripeCheckoutSessionId } : {})
        }
      });
    }
    for (const original of Array.isArray(manifest.originals) ? manifest.originals : []) {
      const originalObjectKey = String(original?.objectKey || '');
      if (!originalObjectKey.startsWith(`${getTinyFrameUploadPrefix(uploadSessionId)}originals/`)) continue;
      const originalObject = await env.ARTWORK_BUCKET.get(originalObjectKey);
      if (!originalObject) throw new Error(`Original picture for ${uploadSessionId} could not be found`);
      await env.ARTWORK_BUCKET.put(originalObjectKey, originalObject.body, {
        httpMetadata:{ contentType:String(original.contentType || 'application/octet-stream') },
        customMetadata:{
          ...(originalObject.customMetadata || {}),
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
      await markUploadSessionsPaid(event.data.object, env);
    } catch (error) {
      console.error('Upload session payment update failed:', error);
      return new Response('Upload session status could not be updated', { status: 503 });
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

export {
  buildLineItems,
  claimWebhookEvent,
  cleanupPendingUploads,
  createStripePayload,
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
        fulfilmentEnabled:Boolean(stripeConfiguration?.fulfilmentEnabled)
      });
    }

    if (request.method === 'POST' && url.pathname === '/create-checkout-session') {
      return createCheckoutSession(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/upload-print-sheet') {
      return uploadTinyFramePrintSheet(request, env);
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
