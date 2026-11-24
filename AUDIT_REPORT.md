# Tiny Frames end-to-end technical audit

**Audit date:** 18 November 2026 (Australia/Brisbane)  
**Audited source:** `GoodFrame-repo` at `d5296be` (`main`)  
**Production storefront checked:** `https://goodframe.com.au/` (read-only)  
**Production Worker checked:** `https://good-frame-checkout.loganwallace049.workers.dev` (read-only health, CORS, and unauthenticated-admin checks only)

## 1. Overall assessment

The current Tiny Frames purchase path is substantially safer and more complete than the legacy implementation. Server-side price calculation, authenticated per-order upload tokens, R2 metadata verification, five-digit product-code allocation, immutable finalized photo snapshots, Stripe idempotency, checkout retry handling, test/live separation, and paid-webhook processing all have meaningful automated coverage. The existing Worker suite passed all 69 tests. Controlled browser runs also completed a six-photo journey through crop, background upload, finalization, cart, A$60 checkout payload creation, and a mocked Stripe redirect in desktop Chromium, simulated Mobile Chrome, and simulated Mobile Safari/WebKit.

The application should not yet be treated as low-risk. Four HIGH issues remain:

1. If the third-party CropperJS CDN is unavailable, selecting a photo leaves customers in a frozen dark crop overlay with all actions disabled.
2. Deployed legacy artwork endpoints allow unauthenticated uploads and public access to legacy objects when their date/six-digit path is known or enumerated.
3. The current guest upload API can be abused to exhaust the finite, never-reused five-digit code pool and R2/D1 capacity; the declared 96 MB aggregate limit is unused and photo-set count is unbounded.
4. The custom Stripe signature parser rejects a header containing more than one `v1` signature when the valid signature is not last, risking paid-order fulfilment failure during webhook-secret rotation.

There were **no committed live Stripe, R2, webhook, Resend, or admin secret values found**. Only secret variable names and synthetic test strings were present. Local ignored Wrangler cache files expose account metadata to the local user but were not committed and their values were not copied into this report.

No production code was changed, no deployment was made, no production POST/upload endpoint was called, no customer photo was opened, and no real or test payment was initiated. This report is the only repository change.

### Severity summary

| Severity | Count | Summary |
|---|---:|---|
| CRITICAL | 0 | No confirmed critical issue |
| HIGH | 4 | Cropper outage freeze; legacy photo/API exposure; upload/code exhaustion; webhook multi-signature rejection |
| MEDIUM | 7 | Format validation mismatch; non-atomic R2 selection mutation; whole-repository deployment; obsolete vulnerable Express stack; accessibility; performance; non-retryable confirmation email |
| LOW | 3 | No crop reset action; duplicate/drifting artifacts; no committed Playwright suite |

## 2. Architecture and complete customer journey

### Frontend

- Static, framework-free storefront in `index.html` (3,950 lines).
- CSS and most JavaScript are inline in `index.html`.
- CropperJS 1.6.1 is loaded at runtime from cdnjs (`index.html:189`, `index.html:1030`).
- Draft crops and cart previews use IndexedDB (`goodFrameCartPhotoPreviews`, version 2).
- Cart and checkout identity use `localStorage` (`tinyFramesCart`, `tinyFramesCheckoutRequest`).
- The frontend points at the Cloudflare Worker in production and `127.0.0.1:8787` on localhost (`index.html:2108-2114`).
- The production page downloaded on 18 November 2026 had the same SHA-1 as the audited `index.html`.

### Current backend

`Stripe_Checkout/worker/src/index.js` is a Cloudflare Worker using:

- D1 (`PRODUCT_CODES_DB`) for product codes, checkout requests, upload sessions, selection versions, and finalized snapshots.
- Private R2 (`ARTWORK_BUCKET`) for photos and manifests.
- Cloudflare Images (`IMAGES`) for server-side image dimension inspection.
- a Workers rate-limit binding.
- Stripe REST APIs for Checkout Session creation, status, expiration, and shipping rates.
- Resend for order confirmation email.
- a scheduled daily cleanup for stale drafts.

The live `/health` endpoint returned `stripeMode: live`, checkout configured, fulfilment enabled, and D1 product identification configured. No credentials were returned.

### Current API surface

| Method | Path | Purpose | Authentication/control |
|---|---|---|---|
| GET | `/health` | Deployment status | Public, no secrets returned |
| GET | `/shipping-quote` | Server-verified shipping | Allowed-origin check |
| POST | `/tiny-frame-upload/session` | Create/recover upload session and reserve product code | Allowed-origin check; client creates initial token |
| POST | `/tiny-frame-upload/selection` | Versioned selected-photo order | `X-Upload-Token` + origin |
| POST | `/tiny-frame-upload/photo` | Validate and store cropped JPEG | `X-Upload-Token` + origin + rate limiter |
| DELETE | `/tiny-frame-upload/photo` | Legacy direct deletion | `X-Upload-Token` + origin |
| POST | `/tiny-frame-upload/finalize` | Verify R2 objects and snapshot selection | `X-Upload-Token` + origin |
| GET | `/tiny-frame-upload/status` | Restore/recover upload state | `X-Upload-Token` + origin |
| POST | `/create-checkout-session` | Validate cart, allocate codes, create/reuse Stripe session | Allowed-origin check |
| GET | `/checkout-session-status` | Verify return from Stripe | Allowed-origin check + cart request/session relationship |
| POST | `/stripe-webhook` | Paid/expired Stripe events | HMAC signature + live/test match |
| GET | `/admin/product-code*` | Order/product lookup | Bearer `ADMIN_API_KEY` |
| GET | `/admin/product-assets*` | Private paid-photo/legacy PDF downloads | Bearer `ADMIN_API_KEY` |
| POST/GET | `/artwork/*` | Legacy original/thumbnail upload and retrieval | Origin only on writes; public reads (issue H-02) |

### Customer journey traced

1. The customer starts with six slots and A$60 (`index.html:1203-1245`). Each extra three-photo set adds A$6.
2. A file input opens. Selected files are mapped to the selected slot and then remaining empty slots (`index.html:1678-1697`).
3. The cropper creates a bounded source image (maximum dimension 4096), constrains the crop to 54:86 or its rotated inverse, and creates a preview JPEG (`index.html:1508-1613`, `index.html:1863-1921`).
4. On confirmation, the preview is committed immediately. A full-resolution crop is generated asynchronously from the original and encoded as JPEG (`index.html:1949-2026`).
5. Originals, crops, tokens, selection identity, and upload state are persisted to IndexedDB for refresh recovery (`index.html:2475-2689`).
6. The browser creates a `tf_...` session/token and `ci_...` cart item. The Worker reserves a globally unique five-digit code and readable Brisbane folder, for example `uploads/2026-11-18 - 05.00 PM - 12345/` (`index.html:2894-2994`, `worker/src/index.js:440-527`).
7. The active selection is synchronized with compare-and-swap `selectionVersion` semantics (`index.html:2995-3057`, `worker/src/index.js:530-620`).
8. At most two cropped JPEGs upload concurrently. The client uses a 120-second default timeout, up to five attempts, jittered exponential backoff, status recovery, and visible processing/queued/uploading/verifying/failed states (`index.html:2779-2875`, `index.html:3063-3247`).
9. The Worker enforces JPEG, non-empty file, 20 MB per cropped photo, readable dimensions, and a 54:86 ratio tolerance before conditional R2 write; it then `HEAD`s the object and verifies size/content type/session/photo/revision metadata before reporting success (`worker/src/index.js:719-1018`).
10. Add to Cart is disabled until every configured slot is complete. Finalization verifies D1 order, all R2 objects, identities, revisions, unique keys, and count, then stores a server-side snapshot (`index.html:3249-3302`, `worker/src/index.js:1042-1204`).
11. The cart stores the finalized upload session. Shipping is re-quoted server-side. Checkout sends only durable item/session/count data, not client-trusted prices or R2 keys (`index.html:3419-3469`).
12. The Worker recalculates price, re-verifies the finalized R2 snapshot, allocates/reattaches product codes, builds Stripe line items and PaymentIntent metadata, and uses the checkout request ID as Stripe's idempotency key (`worker/src/index.js:1480-1805`, `worker/src/index.js:2055-2212`).
13. Cancellation returns to the retained cart. Repeated clicks reuse the same open Stripe session or safely expire/replace an unpaid changed session.
14. On return, the browser asks the Worker to verify that the Stripe session belongs to the cart and polls for `confirmed`, `failed`, or `processing` before clearing purchased items (`index.html:3797-3846`, `worker/src/index.js:2215-2274`).
15. A valid paid webhook marks codes and photos paid, preserves the current readable product folder for current storage, writes/updates the manifest, and sends confirmation email (`worker/src/index.js:2661-2935`, `worker/src/index.js:3039-3130`).

### Dependencies and deployment

- Current Worker dev dependency: Wrangler `^4.98.0`; current registry version observed during the audit was 4.164.0. There is no Worker lockfile.
- Frontend runtime dependency: CropperJS 1.6.1 from cdnjs; current major is 2.x.
- Obsolete Express backend dependencies: dotenv 17.0.0, EJS 3.1.10, Express 5.1.0, Stripe 18.2.1.
- GitHub Pages deploys the repository with a broad `rsync`, not an explicit public allowlist (`.github/workflows/static.yml`).
- A separate workspace-level hosting artifact and `.sites-checkout` copy exist outside this repository and do not match the current source.

## 3. Tests performed

### Repository and static inspection

- Enumerated all tracked source, assets, migrations, tests, generated/vendor content, and deployment configuration.
- Traced every frontend upload/crop/cart/checkout state transition and every Worker route.
- Reviewed D1 migrations, R2 key generation, CORS, upload-token hashing, rate limiting, cleanup, admin access, Stripe payload generation, session reconciliation, return status, webhook verification, and email flow.
- Searched for committed live/test Stripe secrets, webhook secrets, private keys, R2/AWS credentials, and environment files. No real secret value was found.
- Compared the live storefront response to local source by hash.
- Confirmed the live Worker health response, allowed/disallowed CORS preflight behavior, and unauthenticated admin rejection with read-only requests.
- Checked production dependency advisories with `npm audit` and versions with `npm outdated`/registry metadata.

### Existing automated tests

Executed from `Stripe_Checkout/worker`:

```text
npm test
```

Result: **69 passed, 0 failed** in Node's test runner. Tests use in-memory D1/R2 and mocked Stripe; they do not contact production.

Executed Worker packaging without deployment:

```text
npx wrangler deploy --dry-run --env=""
```

Result: **passed**; 170.93 KiB bundle (33.95 KiB gzip). No deployment or migration occurred.

### Controlled Playwright browser audit

The audit harness was created outside the repository under `/tmp`; it did not modify application code. All Worker, R2, shipping, and Stripe calls were intercepted with mocks.

Profiles executed:

- Desktop Chromium, 1440 × 900.
- Desktop Chromium, 1280 × 800 with 120 ms API delay, one connection abort, then one HTTP 503.
- Simulated Mobile Chrome (Pixel 7 profile), 412 × 915.
- Simulated Mobile Safari/WebKit (iPhone 13 profile), 390 × 844.

These are browser-engine/device emulations, **not tests on a physical Android phone or iPhone**.

### Performance and accessibility

- Axe WCAG A/AA scan in Chromium.
- Lighthouse 13 mobile synthetic run against the local production-matching page.
- Object URL instrumentation counted every `URL.createObjectURL` and `URL.revokeObjectURL` during replacements/reset.
- A separate CropperJS-CDN outage run blocked cdnjs and selected a valid JPEG.

### Stripe-specific controlled tests

- Existing in-memory Worker tests covered correct amounts/counts, Stripe line-item metadata, final selected filenames, missing R2 objects, replacements, session reuse/expiration, failures, cancellation return status, concurrency, webhooks, and test/live separation.
- A synthetic webhook request verified one valid `v1` signature succeeds, while a header with a valid `v1` followed by a second invalid `v1` fails.
- No Stripe API call was made with real or test credentials.

## 4. Tests passed

### Backend/in-memory passes

- All 69 existing Worker tests passed.
- Five-digit codes were exactly five non-sequential digits, unique, persistent, and never reassigned in tested flows.
- Readable Brisbane upload folder generation passed.
- CORS allowed configured storefront origins and rejected the tested unapproved origin.
- Upload session authentication, malformed/expired credential recovery, token hashing, replacement supersession, upload retry recovery, and R2 verification passed.
- R2 in-memory tests confirmed a success response was not returned unless the stored object's size/type/session/photo/revision metadata matched.
- Collision tests failed closed without overwriting paid or unrelated photos.
- Stale cleanup removed tested abandoned drafts while retaining paid and active checkout photos.
- Pricing passed for 6/9/12/15/18 photos using A$60 + A$6 per extra three.
- Stripe received server-calculated totals and exact selected-photo counts.
- Final metadata contained exactly 6, 9, 12, 15, or 18 ordered photo fields in the tested single-frame cases.
- Replaced revisions, missing R2 objects, invalid order, duplicate keys, and quantity mismatch were rejected.
- The completed replacement was the only photo associated with its Stripe slot.
- Multiple frames retained separate codes, colours, quantities, and selected R2 keys.
- Repeated/concurrent checkout attempts preserved idempotency and unique codes.
- Payment failure/cancellation/processing/confirmed outcomes behaved as expected in mocked tests.
- Test mode rejected live credentials/events and suppressed fulfilment/email side effects.

### Browser passes

| Test | Result | Evidence |
|---|---|---|
| 6/9/12/15-photo UI pricing | PASS | A$60 / A$66 / A$72 / A$78 |
| Portrait crop ratio | PASS | Measured 0.628; intended 54/86 = 0.628 |
| Rotate crop ratio | PASS | Measured 1.593; intended 86/54 = 1.593 |
| Crop cancel | PASS | Initial selection was not committed |
| JPEG crop/upload | PASS | Preview 565 × 900; mocked upload completed |
| PNG crop/upload | PASS | Preview 729 × 1162; mocked upload completed |
| Preview-to-output aspect | PASS | Both emitted preview blobs matched 54:86 within tolerance |
| Cancelled replacement | PASS | Previous preview and uploaded state remained intact |
| Repeated replacement | PASS | Three sequential replacements completed in one slot |
| Reset all images | PASS | All slots cleared and selection sync ran |
| Object URL release | PASS | 22 created, 22 revoked, 0 live after reset in the instrumented path |
| Invalid text file | PASS | Clear “could not be opened…retry or cancel” error shown |
| Large source JPEG | PASS | 11.9 MB JPEG opened, cropped, and completed mocked upload |
| Interrupted/503 upload retry | PASS | Connection abort + 503 recovered on attempt 3 |
| Refresh recovery | PASS | IndexedDB preview restored and server status reconciled |
| Simulated Mobile Chrome full flow | PASS | Six crops/uploads, finalize, A$60 cart, synchronized checkout body, redirect |
| Simulated Mobile Safari/WebKit full flow | PASS | Same full mocked journey passed at 390 × 844 |
| Single-click crop completion | PASS | No double click was needed in Chromium or WebKit runs |
| Normal-flow JavaScript exceptions | PASS | None captured in the three main browser profiles |
| Worker dry-run bundle | PASS | Built without deploying |
| Live CORS preflight | PASS | Production allowed `goodframe.com.au`, rejected `evil.example` |
| Live admin protection | PASS | Unauthenticated capacity request returned 401 |

## 5. Tests failed

| Test | Result | Summary |
|---|---|---|
| Unsupported source rejection | FAIL | SVG (`image/svg+xml`) was accepted and opened by the cropper |
| Axe WCAG A/AA | FAIL | Critical `label` rule on six file inputs |
| Lighthouse accessibility | FAIL | Missing labels plus two visible-label/accessibility-name mismatches |
| Cropper CDN outage | FAIL | `ReferenceError: Cropper is not defined`; dark overlay visible; Save and Cancel disabled |
| Stripe multiple-`v1` signature | FAIL | Valid first `v1` + invalid second `v1` returned HTTP 400 |
| Legacy Express `npm audit` | FAIL | 6 vulnerable packages: 1 critical, 4 high, 1 moderate |
| Lighthouse performance | FAIL/needs work | Performance 69; synthetic LCP 13.1 s; estimated 7,028 KiB image savings |

The local Lighthouse console-error item was caused by deliberately not starting the local Worker for that standalone performance run. Controlled Playwright runs mocked the Worker and had no normal-flow console exceptions.

## 6. Issues that could prevent customers from ordering and security vulnerabilities

### H-01 — HIGH — Cropper CDN failure freezes the ordering interface

**Affected files:** `index.html:189`, `index.html:1030`, `index.html:1547-1613`, `index.html:2029-2038`  
**Type:** Ordering blocker; mobile/desktop reliability; supply-chain availability

**Steps to reproduce (executed):**

1. Block `https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.1/*`.
2. Load the storefront and select a valid JPEG.
3. Observe the dark crop overlay.

**Observed:** `ReferenceError: Cropper is not defined`; overlay remains visible; Save and Cancel are disabled. The customer cannot crop, cancel, or continue without reloading.

**Likely cause:** CropperJS is a hard runtime dependency loaded from one third-party CDN. `loadCurrentCropPhoto()` calls `new Cropper(...)` inside an image `onload` callback with no availability guard or catch. The code sets the entire crop UI to processing before that call.

**Recommended fix:** Self-host and version-lock CropperJS, add Subresource Integrity if an external fallback remains, detect `globalThis.Cropper` before opening the dialog, wrap cropper construction in `try/catch`, re-enable Cancel on initialization failure, and show a recoverable error. Add a Playwright test that aborts both CropperJS requests.

### H-02 — HIGH — Legacy artwork uploads and customer images are not authenticated

**Affected files:** `Stripe_Checkout/worker/src/index.js:1275-1399`, `Stripe_Checkout/worker/src/r2-keys.js:3-92`, `Stripe_Checkout/worker/src/index.js:3484-3498`  
**Type:** Customer-photo confidentiality; unauthorized storage; overwrite/abuse

**Steps to reproduce (code-reviewed only; production mutation and customer access deliberately not attempted):**

1. Send `POST /artwork/upload` with an allowed `Origin`, any client-chosen six-digit ID, and a file claiming an accepted image MIME type.
2. The route stores it without a session token, aggregate limit, image decoding, or magic-byte validation.
3. Request `GET /artwork/uploads/YYYY/MM/DD/NNNNNN/original.jpg`; the read route has no authentication.
4. Six-digit IDs and calendar folders are enumerable. Thumbnail writes are unconditional once an original key exists.

**Likely cause:** CORS origin checks are being used as authorization for a retired direct-upload design. CORS is enforced by browsers; non-browser clients can send an `Origin` header. The older API predates the `X-Upload-Token`/D1 session design.

**Recommended fix:** Disable/remove `/artwork/upload`, `/artwork/manifest`, and public `/artwork/*` if no longer required. If legacy reads must remain, migrate them behind an authenticated/admin proxy or short-lived signed authorization and use unguessable keys. Enforce magic bytes, decoded dimensions, per-file/aggregate size, conditional writes, ownership, and strict rate limits. Audit R2 access logs and legacy objects without downloading customer content unnecessarily.

### H-03 — HIGH — Guest upload abuse can exhaust five-digit codes and storage

**Affected files:** `Stripe_Checkout/worker/src/index.js:58-68`, `Stripe_Checkout/worker/src/index.js:430-527`, `Stripe_Checkout/worker/src/index.js:530-620`, `Stripe_Checkout/worker/src/index.js:719-1018`, `Stripe_Checkout/worker/src/product-codes.js`, `Stripe_Checkout/worker/migrations/0001_product_codes.sql`  
**Type:** Availability; cost abuse; unauthorized uploads

**Steps to reproduce (code-reviewed only; production mutation deliberately not attempted):**

1. Generate arbitrary valid `tf_...`, `ut_...`, and `ci_...` values.
2. Call `/tiny-frame-upload/session` while sending the storefront Origin.
3. Each accepted call reserves a never-reused code from a pool of 90,000.
4. Create selections with arbitrarily large `photoSetCount`; upload up to 20 MB per photo.
5. Rotate session IDs. Upload rate keys include the session, so a new session gets a new counter.

**Observed in code:** `MAX_TINY_FRAME_UPLOAD_BYTES` (96 MB) and `SUPPORTED_TINY_FRAME_IMAGE_TYPES` are declared but unused by the current individual uploader. `normalizePhotoSetCount()` has no business maximum. The test suite explicitly confirms more than 300 photos is permitted. Cleanup expires sessions/photos but product codes are intentionally never recycled.

**Likely cause:** Upload credentials establish possession after session creation but session creation itself has no user proof/attestation. Rate limiting is per mutable attacker-selected identity and does not enforce a strict account/IP/ASN/storage budget.

**Recommended fix:** Require a server-issued, short-lived upload grant after Turnstile or equivalent bot/abuse verification; add route-level WAF limits; enforce a realistic maximum set/photo count and aggregate bytes in both selection and upload paths; rate-limit session creation independently and strictly; rate uploads against stable abuse dimensions as well as session; monitor reservation velocity/R2 bytes; and redesign code allocation so abandoned malicious reservations cannot permanently exhaust the namespace while paid codes remain immutable.

### H-04 — HIGH — Custom Stripe verifier rejects multiple `v1` signatures

**Affected file:** `Stripe_Checkout/worker/src/index.js:2315-2357`  
**Type:** Paid-order fulfilment failure

**Steps to reproduce (executed with a synthetic test-mode event):**

1. Sign the event body correctly.
2. Send `Stripe-Signature: t=<now>,v1=<valid>,v1=<invalid>`.
3. Observe HTTP 400 `Invalid signature`.

**Observed:** A header with only the valid `v1` returned 200; the two-`v1` header returned 400.

**Likely cause:** `Object.fromEntries()` collapses repeated `v1` keys and retains only the last value. Stripe can include more than one signature during secret rotation. A paid event could then fail on every retry, leaving photos in checkout-pending state and delaying fulfilment.

**Recommended fix:** Prefer Stripe's official webhook construction/verification implementation where compatible. Otherwise parse all `v1` values, reject malformed timestamp/signatures, and accept if any `v1` matches in constant time within tolerance. Add tests for multiple signatures, malformed pairs, duplicate timestamps, and rotation overlap.

### M-01 — MEDIUM — Source file restrictions do not match JPEG/PNG policy

**Affected files:** `index.html:1024`, `index.html:1678-1714`  
**Type:** Validation/UX inconsistency

**Steps to reproduce (executed):** Select an SVG with MIME `image/svg+xml`.

**Observed:** The cropper opened it successfully even though the FAQ says only PNG and JPEG are supported. The input uses `accept="image/*"` and performs no explicit MIME/signature check. Browsers may also accept WebP, GIF, HEIC where decodable, or mislabeled files.

**Likely cause:** Validation is deferred to image decoding; the frontend converts any decodable source to JPEG. The current server correctly validates the resulting JPEG, dimensions, and ratio, but does not know the original source type.

**Recommended fix:** Use `accept="image/jpeg,image/png,.jpg,.jpeg,.png"`, reject other MIME types before opening the cropper, verify magic bytes in a Worker if originals are ever sent, and give an explicit supported-format/size message. Decide and document whether HEIC/WebP should be supported rather than relying on browser differences.

### M-02 — MEDIUM — R2 selection mutation happens before the D1 compare-and-swap commits

**Affected file:** `Stripe_Checkout/worker/src/index.js:530-717`  
**Type:** Potential photo loss/orphan under concurrent tabs or racing selection updates

**Steps to reproduce (not executed against R2; derived from code):**

1. Open the same saved draft in two contexts with the same selection version.
2. Replace/reorder photos concurrently.
3. Each request calls `normalizeProductPhotoSelection()` before `savePhotoUploadSelection()` performs the D1 CAS.
4. The losing request may already have deleted or moved R2 objects before learning that its D1 write lost.

**Likely cause:** `normalizeProductPhotoSelection()` deletes unselected keys and renumbers retained keys as a precondition to the database commit. R2 changes and D1 are not transactional.

**Recommended fix:** Store immutable revision-addressed objects, commit the new D1 selection first, and perform cleanup/renaming only after a successful CAS using a durable reconciliation job. Never delete a key still referenced by any active/snapshot selection. Add deterministic two-client race tests that force the D1 CAS loser after R2 preparation.

### M-03 — MEDIUM — Production publishes backend source, tests, lockfile, and vendor tree

**Affected files:** `.github/workflows/static.yml`, tracked `Stripe_Checkout/node_modules/**`, the repository layout  
**Type:** Information disclosure; oversized deployment; maintenance risk

**Steps to reproduce (executed, read-only):**

1. Request `https://goodframe.com.au/Stripe_Checkout/worker/src/index.js`.
2. Request `https://goodframe.com.au/Stripe_Checkout/package-lock.json`.

**Observed:** Both returned HTTP 200. The repository has 1,617 tracked files, including 1,476 under `Stripe_Checkout/node_modules`. The workflow copies nearly the whole checkout to Pages.

**Likely cause:** The Pages job uses a broad `rsync` and `node_modules` was committed. No secret value was found, so this is not a confirmed credential leak, but it exposes exact implementation/dependency details and needlessly enlarges the public artifact.

**Recommended fix:** Deploy from an explicit public directory/allowlist containing only storefront HTML, required assets, manifests, and public confirmation content. Remove tracked vendor files, add `node_modules/` to `.gitignore`, install with a lockfile in CI where needed, and add a deployment test that rejects backend/test/config paths.

### M-04 — MEDIUM — Obsolete Express checkout has vulnerable dependencies and conflicting logic

**Affected files:** `Stripe_Checkout/index.js`, `Stripe_Checkout/package.json`, `Stripe_Checkout/package-lock.json`, `Stripe_Checkout/Views/**`, `Stripe_Checkout/node_modules/**`  
**Type:** Stale attack surface; duplicate business logic

**Steps to reproduce (executed):** Run `npm audit --omit=dev --json` in `Stripe_Checkout`.

**Observed:** 6 vulnerable packages: 1 critical (`proxy-addr`), 4 high, and 1 moderate. The old server accepts 100 MB JSON, uses legacy A$64.95-only Tiny Frame pricing, six-digit code parsing, and a separate Stripe SDK flow. `npm test` is an intentional failure placeholder.

**Likely cause:** The Worker replaced Express but the old service, dependencies, admin view, and checkout view were retained and are publicly deployed as static files.

**Recommended fix:** Confirm it is not running anywhere, then remove/archive it outside the production repository and remove tracked dependencies. If it is running, treat the dependency remediation as HIGH, update immediately, reduce body limits, and converge on the Worker as the only checkout authority.

### M-05 — MEDIUM — Upload controls and footer links fail accessibility rules

**Affected files:** `index.html:923-929`, `index.html:1700-1715`  
**Type:** WCAG/accessibility

**Steps to reproduce (executed):** Run Axe WCAG A/AA or Lighthouse accessibility on the initial page.

**Observed:** All six generated file inputs lack labels (Axe critical `label`, WCAG 4.1.2). The Instagram and email links have visible text that is not contained in their `aria-label` accessible names (WCAG 2.5.3). Lighthouse accessibility was 94.

**Likely cause:** The visible slot button has an accessible label but the programmatically clicked input does not. Footer `aria-label`s replace, rather than include, visible link text.

**Recommended fix:** Give each input a unique ID and associated label or matching `aria-label`; ensure the visible button/input relationship is clear to assistive technology. Remove redundant footer `aria-label`s or include the visible text exactly. Re-run keyboard, screen-reader, Axe, and Lighthouse tests.

### M-06 — MEDIUM — Mobile synthetic performance is poor and images are oversized

**Affected files:** `index.html` inline CSS/JS and image markup around `index.html:840-898`; `Assets/coffee/gallery-*.webp`; `Assets/graphics/*.png`; `Assets/hand-drawn-cart.png`  
**Type:** Conversion/performance risk

**Steps to reproduce (executed):** Lighthouse 13 mobile synthetic run against the local production-matching page.

**Observed:** Performance 69, FCP 3.0 s, LCP 13.1 s, TBT 80 ms, CLS 0, Speed Index 3.1 s. Lighthouse estimated 7,028 KiB image savings. Four gallery WebPs are approximately 1.4-1.6 MB each; a 296 KB cart icon renders at roughly 24 px; a 358 KB decorative image renders around 26 px. The 234 KB HTML includes most CSS/JS inline, with about 96 KB of JS and 42 KB of CSS estimated unused on initial load.

**Likely cause:** Very large source assets, `sizes="100vw"` on gallery items whose rendered widths are smaller, aggressive DPR selection, and a monolithic inline page that eagerly parses features not needed for first paint.

**Recommended fix:** Generate appropriately compressed AVIF/WebP variants and tiny icon assets, provide accurate responsive `sizes`, lazy-load every below-fold gallery image, split/defer configurator/cart code until needed, self-host/defer CropperJS CSS/JS, and establish a performance budget in CI. Re-test against the deployed CDN; this was lab data, not field Core Web Vitals.

### M-07 — MEDIUM — Confirmation email failures are permanently acknowledged

**Affected file:** `Stripe_Checkout/worker/src/index.js:2409-2464`, `Stripe_Checkout/worker/src/index.js:3102-3124`  
**Type:** Customer communication reliability

**Steps to reproduce (not executed against Resend; code-reviewed):** Make Resend/template retrieval fail after a paid webhook event is claimed.

**Observed in code:** The failure is logged but the Worker returns 200. The event claim remains stored, so Stripe will not retry and the app has no notification outbox/retry state.

**Likely cause:** Avoiding duplicate emails was prioritized without a durable, independently idempotent notification job.

**Recommended fix:** Persist a deterministic notification record keyed by Checkout Session/event, queue delivery, retry with backoff, and mark sent only after Resend success. Keep payment/fulfilment acknowledgement independent so fulfilment remains idempotent.

### L-01 — LOW — Cropper has rotate/cancel/confirm but no reset action

**Affected file:** `index.html:905-910`, cropper handlers around `index.html:1830-1841`  
**Steps to reproduce:** Open a photo and inspect controls.

**Observed:** Rotate, Cancel, Back, and Next/Finish exist. “Reset Images” clears all selected photos outside the cropper, but there is no reset-current-crop action.

**Likely cause:** Reset was implemented only at the full selection level.

**Recommended fix:** Add a clearly labeled reset-current-crop control restoring the initial crop/zoom/orientation and cover it in desktop/touch tests.

### L-02 — LOW — Duplicate and drifting deploy artifacts obscure the source of truth

**Affected paths:** workspace root `dist/`, `.sites-checkout/`, workspace `.openai/hosting.json`, `GoodFrame-repo` legacy views/assets  
**Steps to reproduce (executed):** Compare hashes and file inventories.

**Observed:** `.sites-checkout/index.html` differs from `GoodFrame-repo/index.html`; the top-level `dist` is incomplete for the current site; multiple duplicate font/image/static copies exist.

**Likely cause:** Several hosting/export workflows were retained after the GitHub Pages/Worker architecture evolved.

**Recommended fix:** Declare `GoodFrame-repo` as the only source, generate one clean public artifact, and remove/archive stale exports only after confirming no hosting integration depends on them.

### L-03 — LOW — Playwright coverage is not committed or run in CI

**Affected files:** repository-wide; `.github/workflows/static.yml`  
**Steps to reproduce:** Search for Playwright config/tests and inspect CI.

**Observed:** No Playwright config or browser tests exist in the repository. The audit harness was intentionally temporary because this phase prohibited application changes before report approval.

**Recommended fix:** After approval, add a mock-backed Playwright suite for desktop Chromium, Pixel-class Chromium, and iPhone-class WebKit; run it before deployment; preserve traces/screenshots on failure; and keep physical-iPhone smoke testing as a separate release checklist item.

## 7. Mobile-specific findings

### Passed in simulated mobile engines

- Six sequential crops completed with one click each.
- 54:86 preview output remained correct.
- Background uploads reached the mocked verified state.
- Add to Cart, A$60 price, shipping confirmation, checkout body, and redirect completed.
- No uncaught JavaScript error appeared in the normal simulated Mobile Chrome or WebKit flow.
- The cropper did not show a black screen or freeze when its dependency loaded normally.

### Mobile risks

- H-01 produces exactly the reported frozen/dark cropper symptom on every browser when cdnjs is unavailable; in-app browsers and privacy/content blockers are more likely to block third-party resources.
- The 11.9 MB JPEG test passed on desktop Chromium, but mobile memory pressure was not tested with several camera-size images concurrently. The client retains originals, preview blobs, print blobs, and IndexedDB copies during parts of the flow.
- Browser refresh recovery passed in desktop Chromium but was not repeated on a real iOS device, where IndexedDB quota/eviction and memory behavior differ.
- No physical iPhone, iPad, Android device, Instagram in-app browser, or low-memory Safari process was available.

## 8. Recommended fix order

1. **HIGH:** Remove/protect legacy `/artwork/*` endpoints and audit legacy object exposure without opening customer images unnecessarily.
2. **HIGH:** Self-host CropperJS and make initialization failure recoverable; add the CDN-blocked regression test.
3. **HIGH:** Add abuse controls, a real aggregate upload limit, a maximum photo-set count, and a safe product-code reservation lifecycle.
4. **HIGH:** Correct Stripe signature parsing and add rotation/multiple-signature tests.
5. **MEDIUM:** Make selection persistence transactional in effect: immutable R2 revisions, D1 commit first, cleanup after commit.
6. **MEDIUM:** Restrict source selection to explicit JPEG/PNG and show precise validation errors.
7. **MEDIUM:** Deploy an allowlisted public artifact; remove tracked `node_modules` and obsolete Express code after confirming it is unused.
8. **MEDIUM:** Fix labels/accessibility-name mismatches and add Axe to CI.
9. **MEDIUM:** Optimize gallery/decorative assets and split/defer non-critical page code.
10. **MEDIUM:** Add durable retryable confirmation-email delivery.
11. **LOW:** Add crop reset, consolidate stale artifacts, and commit the Playwright suite.

## 9. Testing limitations

- Production R2 was not listed and no customer photo was opened. Missing/orphan counts in the real bucket therefore remain unknown.
- Current R2 writes, metadata verification, collision handling, cleanup, and paid promotion were verified only through the repository's in-memory R2 tests and browser mocks, not the live bucket.
- Production D1 schema/migration state was not queried. The code and migration files were reviewed and the live health endpoint confirmed a binding, but migration application was not proven.
- No production write endpoint was exercised. CORS and admin checks were read-only/OPTIONS only.
- No Stripe-hosted Checkout page, Stripe test account, test card, real webhook delivery, Resend email, or payment failure was executed. Existing tests and mocks covered those code paths without external side effects.
- Mobile tests were Playwright emulation/WebKit runs, not physical iPhone tests. Touch gestures such as pinch zoom were not physically exercised.
- The “large image” browser test used an 11.9 MB valid JPEG. A >20 MB cropped JPEG was not produced; the Worker's 20 MB rejection is covered by code review/unit behavior, not a live upload.
- Slow-network behavior used deterministic 120 ms API delay plus a connection abort and 503. Lighthouse used synthetic mobile throttling. This is not equivalent to all real carrier/network interruption modes.
- Memory-leak evidence is limited to instrumented object URL balance along the tested replacement/reset path. Heap growth across hours of use was not profiled.
- The local ignored Wrangler state contains test R2 blobs. They were not opened or inspected because they may contain image data.
- Dependency advisories and current package versions are time-sensitive as of 18 November 2026.

## 10. Approval boundary

No fix has been implemented. Recommended next work should begin only after approval, starting with H-02/H-01/H-03/H-04 and adding regression tests before any production deployment.
