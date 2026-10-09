# A4 Print Sheet Release Check

The automated check validates the PDF's physical page box, all eight image placement matrices, the 0.25 pt trim boundaries, the 2.5 mm crop-mark offsets, and effective PPI:

```sh
cd Stripe_Checkout/worker
npm run verify:print-sheet
```

To inspect a different generated sheet:

```sh
node scripts/verify-print-sheet.mjs /path/to/print-sheet-a4.pdf
```

The command must report:

- A4 portrait page: 210 x 297 mm
- Eight placed images
- Every image: 54 x 86 mm
- One 0.25 pt light-grey trim boundary around each image
- Crop marks begin 2.5 mm outside each photograph
- Effective cropped-image PPI is reported for every photograph

## Image-quality pipeline

- The browser canvas is used only for the on-screen preview.
- Each untouched original file and its crop coordinates are uploaded to the Worker.
- Originals are stored under the same upload-session prefix as the generated PDF and manifest.
- Cloudflare Images applies the saved crop to the original pixels, keeps JPEG metadata where supported, and creates one quality-100 JPEG encoding for PDF embedding.
- The Worker never enlarges a low-resolution crop. Any crop below 200 PPI at 54 x 86 mm is recorded in the manifest and returned as a warning.
- The Worker-generated PDF is stored as `print-sheet-a4.pdf` and remains downloadable through its returned private artwork URL.

## Required physical sign-off

1. Open the verified PDF in a PDF viewer.
2. Select A4 portrait paper.
3. Select `Actual Size` or `100%` scale.
4. Disable `Fit`, `Scale to Fit`, and printer-driver enlargement or reduction.
5. Print the page.
6. Measure every image's printed boundary with a reliable metric ruler or calipers.
7. Confirm every image measures 54 x 86 mm and record the printer/model used.
8. Confirm the hairline trim boundary sits exactly on each finished edge and the crop marks do not enter the photograph.

Do not deploy a print-sheet change until both the automated command and the physical measurement pass.
