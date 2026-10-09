const MM_TO_POINTS = 72 / 25.4;
const PAGE_WIDTH_MM = 210;
const PAGE_HEIGHT_MM = 297;
const PHOTO_WIDTH_MM = 54;
const PHOTO_HEIGHT_MM = 86;
const PHOTO_GAP_MM = 5;
const GUIDE_WIDTH_POINTS = 0.25;
const CROP_MARK_GAP_MM = 2.5;
const CROP_MARK_LENGTH_MM = 2;
const PRODUCT_CODE_LABEL_BASELINE_MM = 5;
const PRODUCT_CODE_LABEL_FONT_SIZE_POINTS = 9;

const PAGE_WIDTH_POINTS = PAGE_WIDTH_MM * MM_TO_POINTS;
const PAGE_HEIGHT_POINTS = PAGE_HEIGHT_MM * MM_TO_POINTS;
const PHOTO_WIDTH_POINTS = PHOTO_WIDTH_MM * MM_TO_POINTS;
const PHOTO_HEIGHT_POINTS = PHOTO_HEIGHT_MM * MM_TO_POINTS;

function bytesFromText(value) {
  return new TextEncoder().encode(value);
}

function concatenate(chunks) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function number(value) {
  return Number(value).toFixed(6).replace(/\.?0+$/, '');
}

function getA4PrintLayout() {
  const threeAcrossWidth = (PHOTO_WIDTH_MM * 3) + (PHOTO_GAP_MM * 2);
  const twoAcrossWidth = (PHOTO_WIDTH_MM * 2) + PHOTO_GAP_MM;
  const layoutHeight = (PHOTO_HEIGHT_MM * 3) + (PHOTO_GAP_MM * 2);
  const topMargin = (PAGE_HEIGHT_MM - layoutHeight) / 2;
  const threeAcrossLeft = (PAGE_WIDTH_MM - threeAcrossWidth) / 2;
  const twoAcrossLeft = (PAGE_WIDTH_MM - twoAcrossWidth) / 2;

  return Array.from({ length:8 }, (_, index) => {
    const row = Math.floor(index / 3);
    const column = index % 3;
    const left = (row === 2 ? twoAcrossLeft : threeAcrossLeft) + (column * (PHOTO_WIDTH_MM + PHOTO_GAP_MM));
    const top = topMargin + (row * (PHOTO_HEIGHT_MM + PHOTO_GAP_MM));
    return {
      index,
      xMm:left,
      yMm:PAGE_HEIGHT_MM - top - PHOTO_HEIGHT_MM,
      widthMm:PHOTO_WIDTH_MM,
      heightMm:PHOTO_HEIGHT_MM
    };
  });
}

function createGuideCommands(placement) {
  const x = placement.xMm * MM_TO_POINTS;
  const y = placement.yMm * MM_TO_POINTS;
  const width = placement.widthMm * MM_TO_POINTS;
  const height = placement.heightMm * MM_TO_POINTS;
  const gap = CROP_MARK_GAP_MM * MM_TO_POINTS;
  const length = CROP_MARK_LENGTH_MM * MM_TO_POINTS;
  const left = x;
  const right = x + width;
  const bottom = y;
  const top = y + height;

  return [
    // The hairline rectangle is exactly on the finished 54 x 86 mm trim boundary.
    `${number(left)} ${number(bottom)} ${number(width)} ${number(height)} re S`,
    // Horizontal crop marks.
    `${number(left - gap - length)} ${number(bottom)} m ${number(left - gap)} ${number(bottom)} l S`,
    `${number(right + gap)} ${number(bottom)} m ${number(right + gap + length)} ${number(bottom)} l S`,
    `${number(left - gap - length)} ${number(top)} m ${number(left - gap)} ${number(top)} l S`,
    `${number(right + gap)} ${number(top)} m ${number(right + gap + length)} ${number(top)} l S`,
    // Vertical crop marks.
    `${number(left)} ${number(bottom - gap - length)} m ${number(left)} ${number(bottom - gap)} l S`,
    `${number(right)} ${number(bottom - gap - length)} m ${number(right)} ${number(bottom - gap)} l S`,
    `${number(left)} ${number(top + gap)} m ${number(left)} ${number(top + gap + length)} l S`,
    `${number(right)} ${number(top + gap)} m ${number(right)} ${number(top + gap + length)} l S`
  ].join('\n');
}

function readJpegDimensions(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('Each processed print image must be a JPEG.');
  }
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        height:(bytes[offset + 3] << 8) | bytes[offset + 4],
        width:(bytes[offset + 5] << 8) | bytes[offset + 6]
      };
    }
    offset += length;
  }
  throw new Error('The processed JPEG dimensions could not be read.');
}

function readJpegDetails(bytes) {
  const dimensions = readJpegDimensions(bytes);
  let offset = 2;
  let components = 3;
  let expectedIccChunks = 0;
  const iccChunks = new Map();
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    const payloadStart = offset + 2;
    const payloadEnd = offset + length;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      components = bytes[offset + 7] || 3;
    }
    if (
      marker === 0xe2 &&
      payloadEnd - payloadStart >= 14 &&
      String.fromCharCode(...bytes.subarray(payloadStart, payloadStart + 12)) === 'ICC_PROFILE\0'
    ) {
      const sequence = bytes[payloadStart + 12];
      expectedIccChunks = bytes[payloadStart + 13];
      if (sequence > 0) iccChunks.set(sequence, bytes.slice(payloadStart + 14, payloadEnd));
    }
    offset += length;
  }

  let iccProfile = null;
  if (expectedIccChunks > 0 && iccChunks.size === expectedIccChunks) {
    iccProfile = concatenate(Array.from(
      { length:expectedIccChunks },
      (_, index) => iccChunks.get(index + 1)
    ));
  }
  return { ...dimensions, components, iccProfile };
}

function createA4PrintSheetPdf(processedImages, options = {}) {
  if (!Array.isArray(processedImages) || processedImages.length !== 8) {
    throw new Error('Exactly 8 processed images are required.');
  }

  const images = processedImages.map((image, index) => {
    const bytes = image?.bytes instanceof Uint8Array ? image.bytes : new Uint8Array(image?.bytes || []);
    const dimensions = readJpegDetails(bytes);
    const expectedRatio = PHOTO_WIDTH_MM / PHOTO_HEIGHT_MM;
    if (Math.abs((dimensions.width / dimensions.height) - expectedRatio) > 0.01) {
      throw new Error(`Processed image ${index + 1} is ${dimensions.width} x ${dimensions.height}px and does not match the 54 x 86 mm aspect ratio.`);
    }
    return { bytes, ...dimensions };
  });

  const placements = getA4PrintLayout();
  const productCode = String(options.productCode || '');
  if (productCode && !/^[1-9][0-9]{4}$/.test(productCode)) {
    throw new Error('Product code must contain exactly five digits.');
  }
  const imageCommands = placements.map((placement, index) => (
    `q ${number(PHOTO_WIDTH_POINTS)} 0 0 ${number(PHOTO_HEIGHT_POINTS)} ${number(placement.xMm * MM_TO_POINTS)} ${number(placement.yMm * MM_TO_POINTS)} cm /Im${index + 1} Do Q`
  ));
  const guideCommands = [
    '0.72 G',
    `${number(GUIDE_WIDTH_POINTS)} w`,
    ...placements.map(createGuideCommands)
  ];
  const labelCommands = productCode ? [
    '0 G',
    `BT /F1 ${number(PRODUCT_CODE_LABEL_FONT_SIZE_POINTS)} Tf 1 0 0 1 ${number(82 * MM_TO_POINTS)} ${number(PRODUCT_CODE_LABEL_BASELINE_MM * MM_TO_POINTS)} Tm (PRODUCT ${productCode}) Tj ET`
  ] : [];
  const contentBytes = bytesFromText([...imageCommands, ...guideCommands, ...labelCommands].join('\n'));

  const objects = [];
  objects[1] = bytesFromText('<< /Type /Catalog /Pages 2 0 R >>');
  objects[2] = bytesFromText('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  const imageObjectNumbers = images.map((_, index) => index + 5);
  let nextObjectNumber = 5 + images.length;
  const iccObjectNumbers = images.map(image => (
    image.iccProfile && image.components === 3 ? nextObjectNumber++ : null
  ));
  const fontObjectNumber = productCode ? nextObjectNumber++ : null;
  const xObjects = images.map((_, index) => `/Im${index + 1} ${imageObjectNumbers[index]} 0 R`).join(' ');
  const fontResources = fontObjectNumber ? ` /Font << /F1 ${fontObjectNumber} 0 R >>` : '';
  objects[3] = bytesFromText(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${number(PAGE_WIDTH_POINTS)} ${number(PAGE_HEIGHT_POINTS)}] /Resources << /ProcSet [/PDF /Text /ImageC] /XObject << ${xObjects} >>${fontResources} >> /Contents 4 0 R >>`
  );
  objects[4] = concatenate([
    bytesFromText(`<< /Length ${contentBytes.length} >>\nstream\n`),
    contentBytes,
    bytesFromText('\nendstream')
  ]);
  images.forEach((image, index) => {
    const colourSpace = iccObjectNumbers[index]
      ? `[/ICCBased ${iccObjectNumbers[index]} 0 R]`
      : image.components === 1
        ? '/DeviceGray'
        : image.components === 4
          ? '/DeviceCMYK'
          : '/DeviceRGB';
    const decode = image.components === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
    objects[imageObjectNumbers[index]] = [
      bytesFromText(
        `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace ${colourSpace} /BitsPerComponent 8${decode} /Filter /DCTDecode /Length ${image.bytes.length} >>\nstream\n`
      ),
      image.bytes,
      bytesFromText('\nendstream')
    ];
    if (iccObjectNumbers[index]) {
      objects[iccObjectNumbers[index]] = [
        bytesFromText(`<< /N 3 /Alternate /DeviceRGB /Length ${image.iccProfile.length} >>\nstream\n`),
        image.iccProfile,
        bytesFromText('\nendstream')
      ];
    }
  });
  if (fontObjectNumber) {
    objects[fontObjectNumber] = bytesFromText('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  }

  const header = new Uint8Array([
    ...bytesFromText('%PDF-1.4\n%'),
    0xe2, 0xe3, 0xcf, 0xd3,
    ...bytesFromText('\n')
  ]);
  const chunks = [header];
  const offsets = [0];
  let currentOffset = header.length;
  for (let objectNumber = 1; objectNumber < objects.length; objectNumber += 1) {
    const bodyChunks = Array.isArray(objects[objectNumber])
      ? objects[objectNumber]
      : [objects[objectNumber]];
    const objectChunks = [
      bytesFromText(`${objectNumber} 0 obj\n`),
      ...bodyChunks,
      bytesFromText('\nendobj\n')
    ];
    offsets[objectNumber] = currentOffset;
    chunks.push(...objectChunks);
    currentOffset += objectChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  }

  const xrefOffset = currentOffset;
  chunks.push(bytesFromText([
    'xref',
    `0 ${objects.length}`,
    '0000000000 65535 f ',
    ...offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length} /Root 1 0 R >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF',
    ''
  ].join('\n')));

  return concatenate(chunks);
}

const PRINT_SHEET_SPECIFICATION = Object.freeze({
  pageWidthMm:PAGE_WIDTH_MM,
  pageHeightMm:PAGE_HEIGHT_MM,
  photoWidthMm:PHOTO_WIDTH_MM,
  photoHeightMm:PHOTO_HEIGHT_MM,
  gapMm:PHOTO_GAP_MM,
  guideWidthPt:GUIDE_WIDTH_POINTS,
  cropMarkGapMm:CROP_MARK_GAP_MM,
  cropMarkLengthMm:CROP_MARK_LENGTH_MM,
  productCodeLabelBaselineMm:PRODUCT_CODE_LABEL_BASELINE_MM,
  productCodeLabelFontSizePt:PRODUCT_CODE_LABEL_FONT_SIZE_POINTS
});

export {
  MM_TO_POINTS,
  PRINT_SHEET_SPECIFICATION,
  createA4PrintSheetPdf,
  getA4PrintLayout,
  readJpegDimensions
};
