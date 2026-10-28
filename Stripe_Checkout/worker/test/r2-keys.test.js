import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOriginalObjectKey,
  createProductPhotoFolder,
  createThumbnailObjectKey,
  getBrisbaneDateParts,
  getBrisbaneDateTimeParts,
  isValidArtworkObjectKey,
  sanitizeUploadId
} from '../src/r2-keys.js';

test('uses the Brisbane calendar date at the UTC day boundary', () => {
  assert.deepEqual(getBrisbaneDateParts(new Date('2026-08-24T14:01:00Z')), {
    year: '2026', month: '08', day: '25'
  });
});

test('creates a readable Brisbane product-photo folder with 12-hour time', () => {
  const uploadedAt = new Date('2026-10-28T04:35:00.000Z');
  assert.deepEqual(getBrisbaneDateTimeParts(uploadedAt), {
    year:'2026', month:'10', day:'28', hour:'02', minute:'35', dayPeriod:'PM'
  });
  assert.equal(
    createProductPhotoFolder('58321', uploadedAt),
    '2026-10-28 - 02.35 PM - 58321'
  );
});

test('creates original and thumbnail keys in one dated upload folder', () => {
  const original = createOriginalObjectKey(
    '504616',
    { type: 'image/jpeg', name: 'artwork.jpeg' },
    new Date('2026-08-24T14:01:00Z')
  );
  assert.equal(original, 'uploads/2026/08/25/504616/original.jpeg');
  assert.equal(
    createThumbnailObjectKey(original, '504616'),
    'uploads/2026/08/25/504616/thumbnail.png'
  );
});

test('rejects path traversal and mismatched upload IDs', () => {
  assert.throws(() => sanitizeUploadId('../504616'));
  assert.throws(() => createThumbnailObjectKey(
    'uploads/2026/08/25/504616/original.jpg',
    '999999'
  ));
  assert.equal(isValidArtworkObjectKey('504616_original_art.jpg'), false);
});
