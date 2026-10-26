# Individual photo upload system

New Tiny Frame orders upload each full-resolution 54 × 86 crop individually
while the customer continues selecting photos. The browser runs no more than
two uploads at once, retries transient failures, and keeps recoverable drafts
in IndexedDB. Restored drafts re-register their upload session with the Worker
before syncing the current selection. The Worker verifies each JPEG in R2
before reporting it uploaded.
Add to Cart finalizes the server's current ordered selection; it does not create
or upload a print-sheet PDF.

## Cloudflare bindings and secrets

`Stripe_Checkout/worker/wrangler.jsonc` defines the required bindings:

- `ARTWORK_BUCKET`: private R2 bucket (`goodframes` in production).
- `PRODUCT_CODES_DB`: D1 database for product codes, photo selections, snapshots,
  and Stripe relationships. Apply migration `0003_photo_upload_sessions.sql`
  to the production and test databases before deploying this Worker revision.
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
`OPTIONS`, allows `Content-Type`, `Authorization`, and `X-Upload-Token`, and
returns CORS-readable JSON for upload route errors. Browser uploads go through
the Worker; there are no presigned URLs or direct browser-to-R2 requests, so
an R2 bucket CORS policy is not required.

Set `ADMIN_API_KEY` as an encrypted Worker secret. It must be at least 24
characters and is required by the authenticated order-file listing and download
endpoints. Existing Stripe and Resend secrets remain unchanged.

## Temporary selection and finalization

Every browser session gets a unique upload session ID. Each confirmed crop is
written to a unique, immutable key:

```text
temporary/tf_<session-id>/manifest.json
temporary/tf_<session-id>/photos/<random-immutable-id>.jpg
```

The upload token is stored only as a SHA-256 hash. D1 stores the active ordered
photo selection per cart item, including photo identity, revision, position,
and its verified R2 key. Replacing, removing, reordering, or changing set count
updates that selection with a compare-and-swap version. An upload that finishes
after its photo was replaced or removed is rejected and its temporary object
is deleted. Unselected temporary objects remain private and are eligible for
seven-day cleanup.

Before Add to Cart, the Worker snapshots the active selection and verifies that
every selected JPEG still exists with matching upload-session, photo, and
revision metadata. Checkout uses this snapshot rather than client-provided
object keys.

Only a verified, paid Stripe webhook finalizes a new order. The Worker copies
only snapshot photos, in selected order, to:

```text
orders/<stripe-checkout-session-id>/<five-digit-product-code>/manifest.json
orders/<stripe-checkout-session-id>/<five-digit-product-code>/photo-001.jpg
orders/<stripe-checkout-session-id>/<five-digit-product-code>/photo-002.jpg
```

The manifest records the Stripe order ID, product code, frame colour, and
ordered photo references. Conditional R2 writes make retries idempotent and
refuse to replace files belonging to a different order. Paid-order files are
never included in temporary cleanup. Existing legacy product-folder PDFs,
historical orders, and older photo manifests remain readable.

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
