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

- The browser saves each selected crop at its full cropped pixel dimensions and creates a separate reduced on-screen preview.
- The PDF embeds all eight full-resolution crop JPEGs once, without rasterising or rescaling the A4 page.
- PDFs up to 95 MiB use the existing single request. Larger PDFs use resumable, sequential 8 MiB R2 multipart uploads, so the generated PDF bytes are unchanged and every request stays below the edge request limit.
- Failed multipart parts are retried independently. A retry continues from the completed parts while all eight browser selections remain available.
- After multipart completion, the Worker verifies the exact byte length, A4 page box, eight image objects, placement matrices, cut lines, and matching product code using bounded R2 range reads.
- The code-named PDF is associated with its cart product only after validation succeeds. Checkout cannot begin without that stored reference.
- The stored PDF remains available through the private artwork route and is promoted from pending to paid only after Stripe confirms payment.

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
