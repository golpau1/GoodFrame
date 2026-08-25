export const ARTWORK_TIME_ZONE = 'Australia/Brisbane';

const NEW_OBJECT_KEY_PATTERN = /^uploads\/\d{4}\/\d{2}\/\d{2}\/(\d{6})\/(original\.(?:jpg|jpeg|png|gif)|thumbnail\.png)$/;

export function sanitizeUploadId(value) {
  const uploadId = String(value || '').trim();
  if (!/^\d{6}$/.test(uploadId)) {
    throw new Error('Upload ID is invalid');
  }
  return uploadId;
}

export function getBrisbaneDateParts(uploadedAt = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ARTWORK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(uploadedAt);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { year: value.year, month: value.month, day: value.day };
}

export function getOriginalExtension(file) {
  const contentType = String(file?.type || '').toLowerCase();
  const extensionByType = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif'
  };
  let extension = extensionByType[contentType];
  if (contentType === 'image/jpeg' && /\.jpeg$/i.test(String(file?.name || ''))) {
    extension = 'jpeg';
  }
  if (!extension) {
    throw new Error('Artwork must be a JPEG, PNG, or GIF image');
  }
  return extension;
}

export function createUploadFolder(uploadId, uploadedAt = new Date()) {
  const safeUploadId = sanitizeUploadId(uploadId);
  const { year, month, day } = getBrisbaneDateParts(uploadedAt);
  return `uploads/${year}/${month}/${day}/${safeUploadId}`;
}

export function createOriginalObjectKey(uploadId, file, uploadedAt = new Date()) {
  return `${createUploadFolder(uploadId, uploadedAt)}/original.${getOriginalExtension(file)}`;
}

export function createThumbnailObjectKey(originalObjectKey, uploadId) {
  const safeUploadId = sanitizeUploadId(uploadId);
  const match = String(originalObjectKey || '').match(NEW_OBJECT_KEY_PATTERN);
  if (!match || match[1] !== safeUploadId || !match[2].startsWith('original.')) {
    throw new Error('Original artwork key is invalid');
  }
  return `${originalObjectKey.slice(0, originalObjectKey.lastIndexOf('/'))}/thumbnail.png`;
}

export function isValidArtworkObjectKey(value) {
  return NEW_OBJECT_KEY_PATTERN.test(String(value || ''));
}
