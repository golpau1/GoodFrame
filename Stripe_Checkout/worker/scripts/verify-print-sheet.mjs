import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

await import('../../../print-sheet.js');

const MM_TO_POINTS = 72 / 25.4;
const tolerancePoints = 0.01;
const api = globalThis.GoodFramePrintSheet;
const pdfPath = resolve(process.argv[2] || '');

if (!process.argv[2]) {
  throw new Error('Usage: node scripts/verify-print-sheet.mjs /absolute/or/relative/path/to/print-sheet-a4.pdf');
}

assert.deepEqual(api.specification, {
  pageWidthMm:210,
  pageHeightMm:297,
  photoWidthMm:54,
  photoHeightMm:86,
  gapMm:5,
  guideWidthPt:0.25,
  cropMarkGapMm:2.5,
  cropMarkLengthMm:2,
  productCodeLabelBaselineMm:5,
  productCodeLabelFontSizePt:9
});

const placements = api.getA4PrintLayout();
assert.equal(placements.length, 8);
assert.deepEqual(placements.map(item => [item.xMm, item.yMm, item.widthMm, item.heightMm]), [
  [19, 196.5, 54, 86], [78, 196.5, 54, 86], [137, 196.5, 54, 86],
  [19, 105.5, 54, 86], [78, 105.5, 54, 86], [137, 105.5, 54, 86],
  [48.5, 14.5, 54, 86], [107.5, 14.5, 54, 86]
]);

const pdf = new TextDecoder('latin1').decode(await readFile(pdfPath));
const mediaBox = pdf.match(/\/MediaBox\s*\[\s*0(?:\.0+)?\s+0(?:\.0+)?\s+([\d.]+)\s+([\d.]+)\s*\]/);
assert.ok(mediaBox, 'PDF MediaBox is missing');
assert.ok(Math.abs(Number(mediaBox[1]) - (210 * MM_TO_POINTS)) <= tolerancePoints, 'PDF width is not exactly 210 mm');
assert.ok(Math.abs(Number(mediaBox[2]) - (297 * MM_TO_POINTS)) <= tolerancePoints, 'PDF height is not exactly 297 mm');

const placementPattern = /q\s+([\d.]+)\s+0\s+0\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+cm\s+\/Im(\d+)\s+Do\s+Q/g;
const matrices = [...pdf.matchAll(placementPattern)].map(match => ({
  width:Number(match[1]),
  height:Number(match[2]),
  x:Number(match[3]),
  y:Number(match[4]),
  imageNumber:Number(match[5])
}));
assert.equal(matrices.length, 8, 'PDF must contain exactly eight placed images');

matrices.forEach((matrix, index) => {
  const placement = placements[index];
  assert.equal(matrix.imageNumber, index + 1);
  assert.ok(Math.abs(matrix.width - (54 * MM_TO_POINTS)) <= tolerancePoints, `Image ${index + 1} width is not 54 mm`);
  assert.ok(Math.abs(matrix.height - (86 * MM_TO_POINTS)) <= tolerancePoints, `Image ${index + 1} height is not 86 mm`);
  assert.ok(Math.abs(matrix.x - (placement.xMm * MM_TO_POINTS)) <= tolerancePoints, `Image ${index + 1} horizontal position is incorrect`);
  assert.ok(Math.abs(matrix.y - (placement.yMm * MM_TO_POINTS)) <= tolerancePoints, `Image ${index + 1} vertical position is incorrect`);
});

assert.match(pdf, /(?:^|\s)0\.25 w(?:\s|$)/, 'Cutting-guide line width is not exactly 0.25 pt');
const trimRectangles = [...pdf.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re S/g)];
assert.equal(trimRectangles.length, 8, 'PDF must contain one trim-boundary rectangle per image');
trimRectangles.forEach((match, index) => {
  const placement = placements[index];
  assert.ok(Math.abs(Number(match[1]) - (placement.xMm * MM_TO_POINTS)) <= tolerancePoints, `Guide ${index + 1} x position is incorrect`);
  assert.ok(Math.abs(Number(match[2]) - (placement.yMm * MM_TO_POINTS)) <= tolerancePoints, `Guide ${index + 1} y position is incorrect`);
  assert.ok(Math.abs(Number(match[3]) - (54 * MM_TO_POINTS)) <= tolerancePoints, `Guide ${index + 1} width is incorrect`);
  assert.ok(Math.abs(Number(match[4]) - (86 * MM_TO_POINTS)) <= tolerancePoints, `Guide ${index + 1} height is incorrect`);
});

const cropMarkGapPoints = 2.5 * MM_TO_POINTS;
const cropMarkLengthPoints = 2 * MM_TO_POINTS;
placements.forEach((placement, index) => {
  const left = placement.xMm * MM_TO_POINTS;
  const bottom = placement.yMm * MM_TO_POINTS;
  const expected = `${number(left - cropMarkGapPoints - cropMarkLengthPoints)} ${number(bottom)} m ${number(left - cropMarkGapPoints)} ${number(bottom)} l S`;
  assert.ok(pdf.includes(expected), `Picture ${index + 1} is missing its 2.5 mm offset crop marks`);
});

const imageDimensions = [...pdf.matchAll(/\/Subtype \/Image \/Width (\d+) \/Height (\d+)/g)].map(match => ({
  width:Number(match[1]),
  height:Number(match[2])
}));
assert.equal(imageDimensions.length, 8, 'PDF must contain eight JPEG image dimensions');
const effectivePpi = imageDimensions.map(({ width, height }) => Math.min(width / (54 / 25.4), height / (86 / 25.4)));

function number(value) {
  return value.toFixed(6).replace(/\.?0+$/, '');
}

console.log(`DIGITAL PDF CHECK PASSED: ${pdfPath}`);
console.log('Page: 210 x 297 mm, portrait');
console.log('Images: 8 placements, each exactly 54 x 86 mm');
console.log('Guides: 0.25 pt light grey trim boundaries, with 2.5 mm crop-mark gaps');
console.log(`Effective image PPI: ${effectivePpi.map(value => Math.round(value)).join(', ')}`);
if (effectivePpi.some(value => value < 200)) {
  console.warn('WARNING: One or more images are below 200 PPI at final print size.');
}
console.log('PHYSICAL SIGN-OFF REQUIRED: print at Actual Size / 100% with Fit or Scale-to-Fit disabled, then measure every image.');
