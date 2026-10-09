# Stripe test environment

Production remains configured with `STRIPE_MODE=live`. The `test` Wrangler
environment deploys a separate `good-frame-checkout-test` Worker, uses the
separate `goodframes-test` R2 bucket, and has fulfilment and order emails
disabled in code.

## One-time setup

Create the isolated test artwork bucket if it does not already exist:

```sh
npx wrangler r2 bucket create goodframes-test
```

Add credentials through Wrangler's encrypted secret prompts. Never put the
values in this repository, a command argument, or a log:

```sh
npx wrangler secret put STRIPE_TEST_SECRET_KEY --env test
npx wrangler secret put STRIPE_TEST_PUBLISHABLE_KEY --env test
npx wrangler secret put STRIPE_TEST_WEBHOOK_SECRET --env test
```

The test webhook endpoint is the test Worker's `/stripe-webhook` URL and must
subscribe to `checkout.session.completed` in Stripe Test Mode.

Deploy only the isolated environment:

```sh
npx wrangler deploy --env test
```

Do not set `RESEND_API_KEY` in the test environment. Even if it is present,
the Worker suppresses test-mode email and fulfilment side effects.

## Switching modes

The deployment mode is configuration-only:

- Production: the default Wrangler environment, `STRIPE_MODE=live`.
- Testing: `--env test`, where `STRIPE_MODE=test`.

The Worker rejects test/live key mismatches, webhook event mode mismatches,
and Checkout session IDs from the opposite environment. The `/health`
endpoint reports the active mode and whether checkout and fulfilment are
enabled, without returning credentials.

The storefront already supports an environment-specific API URL through
`window.GOOD_FRAME_CHECKOUT_API_BASE_URL`. A staging or local storefront must
point that value at the test Worker before the storefront script runs. The
production storefront should continue pointing at `good-frame-checkout`.
