(() => {
  const MM_TO_POINTS = 72 / 25.4;
  const PAGE_WIDTH_MM = 210;
  const PAGE_HEIGHT_MM = 297;
  const PHOTO_WIDTH_MM = 54;
  const PHOTO_HEIGHT_MM = 86;
  const GAP_MM = 5;
  const GUIDE_WIDTH_POINTS = 0.25;
  const CROP_MARK_GAP_MM = 2.5;
  const CROP_MARK_LENGTH_MM = 2;
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
    chunks.forEach((chunk) => {
      output.set(chunk, offset);
      offset += chunk.length;
    });
    return output;
  }

  function number(value) {
    return value.toFixed(6).replace(/\.?0+$/, "");
  }

  function getA4PrintLayout() {
    const threeAcrossWidth = (PHOTO_WIDTH_MM * 3) + (GAP_MM * 2);
    const twoAcrossWidth = (PHOTO_WIDTH_MM * 2) + GAP_MM;
    const layoutHeight = (PHOTO_HEIGHT_MM * 3) + (GAP_MM * 2);
    const topMargin = (PAGE_HEIGHT_MM - layoutHeight) / 2;
    const threeAcrossLeft = (PAGE_WIDTH_MM - threeAcrossWidth) / 2;
    const twoAcrossLeft = (PAGE_WIDTH_MM - twoAcrossWidth) / 2;
    const placements = [];

    for (let index = 0; index < 8; index += 1) {
      const row = Math.floor(index / 3);
      const column = index % 3;
      const isLastRow = row === 2;
      const left = (isLastRow ? twoAcrossLeft : threeAcrossLeft) + (column * (PHOTO_WIDTH_MM + GAP_MM));
      const top = topMargin + (row * (PHOTO_HEIGHT_MM + GAP_MM));
      placements.push({
        index,
        xMm:left,
        yMm:PAGE_HEIGHT_MM - top - PHOTO_HEIGHT_MM,
        widthMm:PHOTO_WIDTH_MM,
        heightMm:PHOTO_HEIGHT_MM
      });
    }
    return placements;
  }

  function readJpegDimensions(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      throw new Error("Each saved crop must be a JPEG image.");
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
      const isStartOfFrame = [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
        0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
      ].includes(marker);
      if (isStartOfFrame) {
        return {
          height:(bytes[offset + 3] << 8) | bytes[offset + 4],
          width:(bytes[offset + 5] << 8) | bytes[offset + 6]
        };
      }
      offset += length;
    }
    throw new Error("The saved crop dimensions could not be read.");
  }

  function createCutMarkCommands(placement) {
    const x = placement.xMm * MM_TO_POINTS;
    const y = placement.yMm * MM_TO_POINTS;
    const width = placement.widthMm * MM_TO_POINTS;
    const height = placement.heightMm * MM_TO_POINTS;
    const offset = CROP_MARK_GAP_MM * MM_TO_POINTS;
    const length = CROP_MARK_LENGTH_MM * MM_TO_POINTS;
    const left = x;
    const right = x + width;
    const bottom = y;
    const top = y + height;
    return [
      `${number(left)} ${number(bottom)} ${number(width)} ${number(height)} re S`,
      `${number(left - offset - length)} ${number(bottom)} m ${number(left - offset)} ${number(bottom)} l S`,
      `${number(left)} ${number(bottom - offset - length)} m ${number(left)} ${number(bottom - offset)} l S`,
      `${number(right + offset)} ${number(bottom)} m ${number(right + offset + length)} ${number(bottom)} l S`,
      `${number(right)} ${number(bottom - offset - length)} m ${number(right)} ${number(bottom - offset)} l S`,
      `${number(left - offset - length)} ${number(top)} m ${number(left - offset)} ${number(top)} l S`,
      `${number(left)} ${number(top + offset)} m ${number(left)} ${number(top + offset + length)} l S`,
      `${number(right + offset)} ${number(top)} m ${number(right + offset + length)} ${number(top)} l S`,
      `${number(right)} ${number(top + offset)} m ${number(right)} ${number(top + offset + length)} l S`
    ].join("\n");
  }

  async function createA4PrintSheetPdf(croppedBlobs, { includeCutMarks = true } = {}) {
    if (!Array.isArray(croppedBlobs) || croppedBlobs.length !== 8) {
      throw new Error("Exactly 8 saved crops are required to prepare the print sheet.");
    }

    const images = await Promise.all(croppedBlobs.map(async (blob, index) => {
      if (!(blob instanceof Blob) || blob.type !== "image/jpeg" || !blob.size) {
        throw new Error(`Saved crop ${index + 1} is not a valid JPEG image.`);
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const dimensions = readJpegDimensions(bytes);
      const expectedRatio = PHOTO_WIDTH_MM / PHOTO_HEIGHT_MM;
      const actualRatio = dimensions.width / dimensions.height;
      if (Math.abs(actualRatio - expectedRatio) > 0.01) {
        throw new Error(`Saved crop ${index + 1} does not match the required 54 x 86 mm aspect ratio.`);
      }
      return { bytes, ...dimensions };
    }));

    const placements = getA4PrintLayout();
    const imageCommands = placements.map((placement, index) => {
      const x = placement.xMm * MM_TO_POINTS;
      const y = placement.yMm * MM_TO_POINTS;
      return `q ${number(PHOTO_WIDTH_POINTS)} 0 0 ${number(PHOTO_HEIGHT_POINTS)} ${number(x)} ${number(y)} cm /Im${index + 1} Do Q`;
    });
    const cutMarkCommands = includeCutMarks
      ? ["0.72 G", `${number(GUIDE_WIDTH_POINTS)} w`, ...placements.map(createCutMarkCommands)]
      : [];
    const contentBytes = bytesFromText([...imageCommands, ...cutMarkCommands].join("\n"));

    const objects = [];
    objects[1] = bytesFromText("<< /Type /Catalog /Pages 2 0 R >>");
    objects[2] = bytesFromText("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    const xObjects = images.map((_, index) => `/Im${index + 1} ${index + 5} 0 R`).join(" ");
    objects[3] = bytesFromText(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${number(PAGE_WIDTH_POINTS)} ${number(PAGE_HEIGHT_POINTS)}] /Resources << /ProcSet [/PDF /ImageC] /XObject << ${xObjects} >> >> /Contents 4 0 R >>`
    );
    objects[4] = concatenate([
      bytesFromText(`<< /Length ${contentBytes.length} >>\nstream\n`),
      contentBytes,
      bytesFromText("\nendstream")
    ]);
    images.forEach((image, index) => {
      objects[index + 5] = concatenate([
        bytesFromText(
          `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>\nstream\n`
        ),
        image.bytes,
        bytesFromText("\nendstream")
      ]);
    });

    const header = new Uint8Array([
      ...bytesFromText("%PDF-1.4\n%"),
      0xe2, 0xe3, 0xcf, 0xd3,
      ...bytesFromText("\n")
    ]);
    const chunks = [header];
    const offsets = [0];
    let currentOffset = header.length;
    for (let objectNumber = 1; objectNumber < objects.length; objectNumber += 1) {
      const objectBytes = concatenate([
        bytesFromText(`${objectNumber} 0 obj\n`),
        objects[objectNumber],
        bytesFromText("\nendobj\n")
      ]);
      offsets[objectNumber] = currentOffset;
      chunks.push(objectBytes);
      currentOffset += objectBytes.length;
    }

    const xrefOffset = currentOffset;
    const xref = [
      "xref",
      `0 ${objects.length}`,
      "0000000000 65535 f ",
      ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
      "trailer",
      `<< /Size ${objects.length} /Root 1 0 R >>`,
      "startxref",
      String(xrefOffset),
      "%%EOF",
      ""
    ].join("\n");
    chunks.push(bytesFromText(xref));

    return new Blob([concatenate(chunks)], { type:"application/pdf" });
  }

  globalThis.GoodFramePrintSheet = Object.freeze({
    createA4PrintSheetPdf,
    getA4PrintLayout,
    specification:Object.freeze({
      pageWidthMm:PAGE_WIDTH_MM,
      pageHeightMm:PAGE_HEIGHT_MM,
      photoWidthMm:PHOTO_WIDTH_MM,
      photoHeightMm:PHOTO_HEIGHT_MM,
      gapMm:GAP_MM,
      guideWidthPt:GUIDE_WIDTH_POINTS,
      cropMarkGapMm:CROP_MARK_GAP_MM,
      cropMarkLengthMm:CROP_MARK_LENGTH_MM
    })
  });
})();
