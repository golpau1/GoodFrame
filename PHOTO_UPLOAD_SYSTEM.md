# Individual photo upload system

New Tiny Frame orders upload each full-resolution 54 × 86 crop individually
while the customer continues selecting photos. The browser runs no more than
two uploads at once, retries transient failures, and keeps recoverable drafts
in IndexedDB. Restored drafts re-register their upload session with the Worker
before syncing the current selection. The Worker verifies each JPEG in R2
before reporting it uploaded.
Add to Cart finalizes the server's current ordered selection; it does not create
or upload a print-sheet PDF.

If restored credentials are malformed, expired, or no longer match the
server-side token hash, the browser preserves the saved crops, creates one new
authenticated session, retries selection synchronization once, and re-uploads
the preserved JPEGs. Session creation and recovery are single-flight so
simultaneous photo requests cannot create competing replacement sessions.

## Cloudflare bindings and secrets

`Stripe_Checkout/worker/wrangler.jsonc` defines the required bindings:

- `ARTWORK_BUCKET`: private R2 bucket (`goodframes` in production).
- `PRODUCT_CODES_DB`: D1 database for product codes, photo selections, snapshots,
  and Stripe relationships. Apply migrations `0003_photo_upload_sessions.sql`
  through `0006_photo_upload_product_codes.sql` to the production and test
  databases before deploying this Worker revision.
- `IMAGES`: validates stored JPEG dimensions and crop ratio.
- `UPLOAD_RATE_LIMITER`: 120 upload operations per minute per client/session.
- `ALLOWED_ORIGINS`: exact comma-separated storefront origins:
  `https://goodframe.com.au`, `https://www.goodframe.com.au`,
  `http://localhost:4173`, and `http://127.0.0.1:4173`.
- Daily cron: safely removes abandoned temporary upload sessions after seven
  days. Checkout sessions are checked with Stripe before cleanup; paid and
  finalization-pending sessions are retained.

The uploader uses `X-Upload-Token`, not cookies, so cross-origin requests do
not use credentialed CORS. The Worker handles `GET`, `POST`, `DELETE`, and
`OPTIONS`, allows `Content-Type`, `Authorization`, `X-Upload-Token`, and
`X-Upload-Attempt`, and returns CORS-readable JSON for upload route errors.
Browser uploads go through the Worker; there are no presigned URLs or direct
browser-to-R2 requests, so an R2 bucket CORS policy is not required.

The cropper commits each completed crop to the local photo grid and IndexedDB
before starting selection synchronization and upload in the background. It
does not wait for Cloudflare to close. The queue runs at most two uploads
concurrently, retries timeouts and transient network/server responses with
jittered backoff, and leaves permanent failures available for manual retry.
Pending local drafts include the original and print crop where browser storage
allows; a visible warning is shown if the browser cannot save recovery data.
Recovery depends on the browser retaining its local data.

Each upload response is checked against the `storageFolder` returned by the
Worker (not the separate `tf_...` session ID). Upload API responses are marked
`no-store`, and browser upload requests explicitly omit cookies, so stale
browser cache or unrelated site credentials cannot affect authentication. The
Worker confirms object size, JPEG content type, and session/photo/revision
metadata in R2 before marking the selection uploaded. Checkout remains blocked
until every configured photo is confirmed and the Worker finalizes the same
session-bound selection.

Client and Worker diagnostics record Brisbane time, anonymous session/photo
references, a broad browser category, stage, HTTP status, safe error code,
attempt number, duration, and result. They do not include image contents,
customer-identifying data, credentials, or signed URLs. Worker diagnostics are
available only through authenticated Cloudflare logging tools.

Set `ADMIN_API_KEY` as an encrypted Worker secret. It must be at least 24
characters and is required by the authenticated order-file listing and download
endpoints. Existing Stripe and Resend secrets remain unchanged.

## Product photo storage

Each cart product reserves its unique five-digit product code before photo
uploads begin. Cropped photos are written directly into that product's folder,
and the same code is attached to its Stripe line item:

```text
uploads/12345/photo-01.jpg
uploads/12345/photo-02.jpg
```

Upload session IDs and tokens remain private application credentials in D1;
they are not used as R2 folder names. Product codes are globally unique and
never recycled, so one product cannot overwrite another product's photos.
Existing temporary and timestamped folders remain readable for older sessions.

The upload token is stored only as a SHA-256 hash. D1 stores the active ordered
photo selection per cart item, including photo identity, revision, position,
and its verified R2 key. Replacing, removing, reordering, or changing set count
updates that selection with a compare-and-swap version. An upload that finishes
after its photo was replaced or removed is rejected. A retry uses the product
code and photo position, and R2 conditional writes prevent a concurrent update
from replacing another object. Abandoned draft folders are eligible for
seven-day cleanup.

Before Add to Cart, the Worker snapshots the active selection and verifies that
every selected JPEG still exists with matching upload-session, photo, and
revision metadata. Checkout uses this snapshot rather than client-provided
object keys.

Only a verified, paid Stripe webhook finalizes a new order. The Worker keeps
the verified photos and manifest in the same product folder:

```text
uploads/12345/manifest.json
uploads/12345/photo-01.jpg
uploads/12345/photo-02.jpg
```

The manifest records the Stripe order ID, product code, frame colour, and
ordered photo references. Conditional R2 writes make retries idempotent and
refuse to replace files belonging to another product. Paid product folders are
never included in temporary cleanup. Existing legacy product-folder PDFs,
historical orders, and older photo manifests remain readable through the
authenticated admin endpoints, but no new PDF is created.

Variable photo sets have no fixed set limit. The A$50 starting price includes
the first three photos; each additional three-photo set adds A$5. Prices are
calculated server-side using the same rule.

## Local verification

From `Stripe_Checkout/worker`:

```sh
npm test
npx wrangler deploy --dry-run --env=""
```

Run `npm run dev` when exercising browser uploads locally. The storefront
automatically targets `http://127.0.0.1:8787` on localhost. A dry run does not
apply D1 migrations, deploy the Worker, or publish the website.

## Authenticated order files

```text
GET /admin/product-assets/<product-code>
GET /admin/product-assets/<product-code>/photo/<position>
GET /admin/product-assets/<product-code>/legacy-pdf
Authorization: Bearer <ADMIN_API_KEY>
```

The listing returns ordered photo references and secure download URLs. The
photo and legacy PDF endpoints proxy private R2 objects without exposing bucket
credentials or public object URLs.
