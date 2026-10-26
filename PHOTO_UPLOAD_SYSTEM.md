# Individual photo upload system

New Tiny Frame orders upload each finished 54 × 86 crop directly to private R2
storage. The browser runs no more than two uploads at once, retries transient
failures, and keeps recoverable draft data in IndexedDB. Add to Cart only
finalizes an already uploaded set; it does not create or upload a PDF.

## Cloudflare bindings and secrets

`Stripe_Checkout/worker/wrangler.jsonc` defines the required bindings:

- `ARTWORK_BUCKET`: private R2 bucket for draft and paid-order artwork.
- `PRODUCT_CODES_DB`: existing D1 database for permanent five-digit product
  codes and Stripe relationships.
- `IMAGES`: used to validate uploaded JPEG dimensions and crop ratio.
- `UPLOAD_RATE_LIMITER`: 120 upload operations per minute per client/session.
- `ALLOWED_ORIGINS`: exact comma-separated storefront origins:
  `https://goodframe.com.au`, `https://www.goodframe.com.au`,
  `http://localhost:4173`, and `http://127.0.0.1:4173`.
- Daily cron: removes abandoned draft upload prefixes after the configured TTL.

The uploader uses the `X-Upload-Token` request header rather than cookies, so
cross-origin requests do not use credentialed CORS. The Worker validates
preflight methods and headers and returns CORS-readable JSON for route errors.
Keep the deployed Worker variable in sync with the allowlist in
`Stripe_Checkout/worker/wrangler.jsonc`.

Set `ADMIN_API_KEY` as an encrypted Worker secret. It must be at least 24
characters and is required by the order-file listing and download endpoints.
Existing Stripe and Resend secrets remain unchanged.

No new D1 migration is required for this uploader revision. Existing product
code rows already store the upload-session relationship. Apply all existing
migrations to a new local/test database before running checkout tests.

## Storage lifecycle

Draft objects use:

```text
tinyframes/tf_<session>/manifest.json
tinyframes/tf_<session>/photos/ph_<photo-id>.jpg
```

The upload token is stored only as a SHA-256 hash in the manifest. Cropped
files are private and can only be changed by requests presenting the matching
token. On a successful live Stripe webhook, files are copied into their final
per-order and per-product paths:

```text
orders/<stripe-session>/product-<five-digit-code>/manifest.json
orders/<stripe-session>/product-<five-digit-code>/photo-001.jpg
```

Legacy code-named print-sheet PDFs are left in place and remain available to
the authenticated order-management download API.

## Local verification

From `Stripe_Checkout/worker`:

```sh
npm test
npx wrangler deploy --dry-run --env=""
```

Run `npm run dev` when exercising real browser uploads locally. The storefront
automatically targets `http://127.0.0.1:8787` on localhost. Nothing in this
workflow deploys the Worker or publishes the website.

## Authenticated order files

```text
GET /admin/product-assets/<product-code>
GET /admin/product-assets/<product-code>/photo/<position>
GET /admin/product-assets/<product-code>/legacy-pdf
Authorization: Bearer <ADMIN_API_KEY>
```

The first endpoint returns the ordered frame colour, photo count, and secure
download URLs. The other endpoints proxy private R2 objects without exposing
bucket credentials or public object URLs.
