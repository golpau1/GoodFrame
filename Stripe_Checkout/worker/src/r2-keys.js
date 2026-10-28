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

export function getBrisbaneDateTimeParts(uploadedAt = new Date()) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: ARTWORK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).formatToParts(uploadedAt);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    year:value.year,
    month:value.month,
    day:value.day,
    hour:String(value.hour || '').padStart(2, '0'),
    minute:value.minute,
    dayPeriod:String(value.dayPeriod || '').toUpperCase()
  };
}

export function createProductPhotoFolder(productCode, uploadedAt = new Date()) {
  const code = String(productCode || '').trim();
  if (!/^[1-9]\d{4}$/.test(code)) throw new Error('Product code is invalid');
  const { year, month, day, hour, minute, dayPeriod } = getBrisbaneDateTimeParts(uploadedAt);
  if (!/^(?:0[1-9]|1[0-2])$/.test(hour) || !/^\d{2}$/.test(minute) || !/^(?:AM|PM)$/.test(dayPeriod)) {
    throw new Error('Upload time is invalid');
  }
  return `${year}-${month}-${day} - ${hour}.${minute} ${dayPeriod} - ${code}`;
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
