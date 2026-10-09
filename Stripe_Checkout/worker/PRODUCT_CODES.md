# Five-digit product identification

This Worker assigns one permanently unique random five-digit code (`10000` to
`99999`) to every physical product. Codes are allocated by the Worker and
protected by D1 primary-key and per-cart-unit unique constraints. They are
never generated in the browser and never deleted or recycled.

The production and test D1 databases are configured as separate bindings in
`wrangler.jsonc`, so test records cannot mix with real orders.

## Cloudflare setup

Create isolated databases so test records can never mix with real orders:

```sh
npx wrangler d1 create good-frame-product-codes
npx wrangler d1 create good-frame-product-codes-test
```

The returned IDs are stored in `wrangler.jsonc` using the binding name
`PRODUCT_CODES_DB`. The top-level environment uses the production database;
`env.test` and `env.dev` use the test database.

Example binding shape (IDs are intentionally omitted from source):

```jsonc
"d1_databases": [
  {
    "binding": "PRODUCT_CODES_DB",
    "database_name": "good-frame-product-codes",
    "database_id": "<Cloudflare-generated production database ID>",
    "migrations_dir": "migrations"
  }
]
```

Apply the schema before deploying the Worker:

```sh
npx wrangler d1 migrations apply good-frame-product-codes --remote
npx wrangler d1 migrations apply good-frame-product-codes-test --remote
```

Create a long random admin API credential through Wrangler's encrypted prompt:

```sh
npx wrangler secret put ADMIN_API_KEY
npx wrangler secret put ADMIN_API_KEY --env test
```

Never put the value in source, shell history, GitHub, or logs.

## Lookup and capacity monitoring

Authorized lookup:

```text
GET /admin/product-code/58321
Authorization: Bearer <ADMIN_API_KEY>
```

The result links the code to its cart unit, upload session, Stripe Checkout
Session, PaymentIntent, status, and timestamps.

Capacity endpoint:

```text
GET /admin/product-code-capacity
Authorization: Bearer <ADMIN_API_KEY>
```

The total space is 90,000 codes. The response and Worker logs set `low=true`
when 9,000 or fewer remain. Allocation fails closed when exhausted; codes are
never reused.

## Durable relationships

- Each quantity unit becomes its own Stripe line item with `product_code`,
  `cart_item_id`, and `unit_index` metadata.
- Checkout and PaymentIntent metadata contain the full product-code list.
- Stripe idempotency and `checkout_requests` preserve codes across retries.
- Live webhook retries update existing D1 rows and cannot create new products.
- Picture products receive `print-sheet-#####.pdf`, with the code printed in
  the unused bottom A4 margin outside every photo and crop mark.
- R2 manifests, originals, processed crops, and PDFs store the same codes.
