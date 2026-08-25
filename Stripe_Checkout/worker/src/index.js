import {
  createOriginalObjectKey,
  createThumbnailObjectKey,
  isValidArtworkObjectKey,
  sanitizeUploadId
} from './r2-keys.js';

const PRICE_BY_SIZE = Object.freeze({
  '210x297mm': 9900,
  '420x594mm': 23500,
  '594x841mm': 35000,
  '841x1189mm': 70000
});
const CANONICAL_SIZE_BY_DIMENSIONS = Object.freeze({
  '210x297': '210x297mm',
  '200x300': '210x297mm',
  '420x594': '420x594mm',
  '400x600': '420x594mm',
  '594x841': '594x841mm',
  '600x900': '594x841mm',
  '841x1189': '841x1189mm',
  '800x1200': '841x1189mm',
  '900x1200': '841x1189mm'
});

function validateStripeConfiguration(env) {
  const stripeMode = String(env.STRIPE_MODE || '').trim().toLowerCase();
  const secretKey = String(env.STRIPE_SECRET_KEY || '');

  if (!['live', 'test'].includes(stripeMode) || !secretKey) {
    return false;
  }

  return stripeMode === 'live'
    ? secretKey.startsWith('sk_live_')
    : secretKey.startsWith('sk_test_');
}

function getSiteBaseUrl(env) {
  const siteBaseUrl = String(env.SITE_BASE_URL || '').replace(/\/$/, '');
  const stripeMode = String(env.STRIPE_MODE || '').trim().toLowerCase();

  if (!siteBaseUrl || (stripeMode === 'live' && siteBaseUrl !== 'https://goodframe.com.au')) {
    return '';
  }

  return siteBaseUrl;
}

function getAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  const allowedOrigins = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  return origin && allowedOrigins.includes(origin) ? origin : '';
}

function createCorsHeaders(request, env) {
  const headers = new Headers({
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  });
  const allowedOrigin = getAllowedOrigin(request, env);

  if (allowedOrigin) {
    headers.set('Access-Control-Allow-Origin', allowedOrigin);
    headers.set('Vary', 'Origin');
  }

  return headers;
}

function jsonResponse(request, env, payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: createCorsHeaders(request, env)
  });
}

function getWorkerBaseUrl(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function getArtworkUrl(request, objectKey) {
  return `${getWorkerBaseUrl(request)}/artwork/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
}

async function uploadArtwork(request, env) {
  if (!env.ARTWORK_BUCKET) {
    return jsonResponse(request, env, { error: 'Artwork storage is not configured' }, 503);
  }
  if (!getAllowedOrigin(request, env)) {
    return jsonResponse(request, env, { error: 'Origin is not allowed' }, 403);
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse(request, env, { error: 'Upload must use multipart form data' }, 400);
  }

  const file = formData.get('file');
  const kind = String(formData.get('kind') || '');
  let uploadId;
  try {
    uploadId = sanitizeUploadId(formData.get('uploadId'));
  } catch (error) {
    return jsonResponse(request, env, { error: error.message }, 400);
  }
  if (!file || typeof file.arrayBuffer !== 'function') {
    return jsonResponse(request, env, { error: 'An artwork file is required' }, 400);
  }

  let objectKey;
  try {
    if (kind === 'original') {
      objectKey = createOriginalObjectKey(uploadId, file, new Date());
      if (await env.ARTWORK_BUCKET.head(objectKey)) {
        return jsonResponse(request, env, { error: 'Upload ID already exists' }, 409);
      }
    } else if (kind === 'thumbnail') {
      if (file.type !== 'image/png') {
        throw new Error('Thumbnail must be a PNG image');
      }
      objectKey = createThumbnailObjectKey(formData.get('originalObjectKey'), uploadId);
      const originalKey = String(formData.get('originalObjectKey'));
      if (!await env.ARTWORK_BUCKET.head(originalKey)) {
        return jsonResponse(request, env, { error: 'Original artwork was not found' }, 404);
      }
    } else {
      throw new Error('Upload kind is invalid');
    }
  } catch (error) {
    return jsonResponse(request, env, { error: error.message }, 400);
  }

  await env.ARTWORK_BUCKET.put(objectKey, file.stream(), {
    httpMetadata: { contentType: file.type }
  });
  return jsonResponse(request, env, {
    objectKey,
    url: getArtworkUrl(request, objectKey)
  });
}

async function getArtwork(request, env, objectKey) {
  if (!env.ARTWORK_BUCKET || !isValidArtworkObjectKey(objectKey)) {
    return new Response('Not found', { status: 404 });
  }
  const object = await env.ARTWORK_BUCKET.get(objectKey);
  if (!object) {
    return new Response('Not found', { status: 404 });
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', 'private, max-age=3600');
  const allowedOrigin = getAllowedOrigin(request, env);
  if (allowedOrigin) {
    headers.set('Access-Control-Allow-Origin', allowedOrigin);
    headers.set('Vary', 'Origin');
  }
  return new Response(object.body, { headers });
}

function cleanText(value, fallback) {
  const text = typeof value === 'string' ? value : fallback;
  return text.replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
}

function getLegacyProductName(item) {
  const productName = item?.price_data?.product_data?.name;
  return typeof productName === 'string' ? productName : '';
}

function normalizeRequestedSize(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const dimensions = value
    .toLowerCase()
    .replace(/[\u00d7*]/g, 'x')
    .match(/(\d+)\s*x\s*(\d+)\s*mm/);

  if (!dimensions) {
    return null;
  }

  const width = Number(dimensions[1]);
  const height = Number(dimensions[2]);
  const dimensionKey = [width, height]
    .sort((a, b) => a - b)
    .join('x');

  return CANONICAL_SIZE_BY_DIMENSIONS[dimensionKey] || null;
}

function getRequestedSize(item) {
  return normalizeRequestedSize(item?.size) ||
    normalizeRequestedSize(getLegacyProductName(item));
}

function getOrderCode(item) {
  const values = [
    item?.uniqueCode,
    item?.orderCode,
    item?.code,
    item?.productName,
    item?.internalTitle,
    getLegacyProductName(item)
  ];

  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number') {
      continue;
    }

    const match = String(value).match(/\b(\d{6})\b/);
    if (match) {
      return match[1];
    }
  }

  return '';
}

function getOrderCodes(lineItems) {
  return [...new Set(lineItems
    .map(item => item.orderCode)
    .filter(Boolean))];
}

function getOrderCodeMetadataValue(orderCodes) {
  return orderCodes.map(code => `#${code}`).join(', ').slice(0, 500);
}

function buildLineItems(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 10) {
    throw new Error('Cart must contain between 1 and 10 items');
  }

  const lineItems = [];
  let subtotal = 0;

  items.forEach(item => {
    if (getLegacyProductName(item).trim().toLowerCase() === 'shipping') {
      return;
    }

    const size = getRequestedSize(item);
    const unitAmount = PRICE_BY_SIZE[size];

    if (!unitAmount) {
      throw new Error('One or more cart items has an invalid frame size');
    }

    const requestedQuantity = Number(item.quantity);
    const quantity = Number.isInteger(requestedQuantity)
      ? Math.min(Math.max(requestedQuantity, 1), 10)
      : 1;
    const orderCode = getOrderCode(item);
    const description = [
      cleanText(item.orientation, ''),
      item.frameColor ? `${cleanText(item.frameColor, '')} Frame` : '',
      cleanText(item.border, '')
    ].filter(Boolean).join(' | ') || 'Custom framed print';

    subtotal += unitAmount * quantity;
    lineItems.push({
      name: `Print & Frame - ${size}`,
      description,
      unitAmount,
      quantity,
      orderCode,
      originalObjectKey: isValidArtworkObjectKey(item.originalObjectKey) ? item.originalObjectKey : '',
      thumbnailObjectKey: isValidArtworkObjectKey(item.thumbnailObjectKey) ? item.thumbnailObjectKey : '',
      size
    });
  });

  if (lineItems.length === 0) {
    throw new Error('Cart does not contain any purchasable items');
  }

  if (subtotal <= 10000) {
    lineItems.push({
      name: 'Shipping',
      description: 'Standard shipping',
      unitAmount: 1500,
      quantity: 1
    });
  }

  return lineItems;
}

function createStripePayload(lineItems, siteBaseUrl) {
  const orderCodes = getOrderCodes(lineItems);
  const orderCodeMetadataValue = getOrderCodeMetadataValue(orderCodes);
  const payload = new URLSearchParams({
    mode: 'payment',
    success_url: `${siteBaseUrl}/Checkout/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteBaseUrl}/cart.html`,
    billing_address_collection: 'required',
    'shipping_address_collection[allowed_countries][0]': 'AU',
    'shipping_address_collection[allowed_countries][1]': 'US',
    'shipping_address_collection[allowed_countries][2]': 'BR'
  });

  if (orderCodes.length > 0) {
    payload.set('client_reference_id', orderCodes[0]);
    payload.set('metadata[order_codes]', orderCodeMetadataValue);
    payload.set('payment_intent_data[description]', 'Good Frame Order');
    payload.set('payment_intent_data[metadata][order_codes]', orderCodeMetadataValue);
  }

  lineItems.forEach((item, index) => {
    const prefix = `line_items[${index}]`;
    payload.set(`${prefix}[price_data][currency]`, 'aud');
    payload.set(`${prefix}[price_data][product_data][name]`, item.name);
    payload.set(`${prefix}[price_data][product_data][description]`, item.description);
    if (item.orderCode) {
      payload.set(`${prefix}[price_data][product_data][metadata][order_code]`, item.orderCode);
      payload.set(`${prefix}[price_data][product_data][metadata][frame_size]`, item.size);
      if (item.originalObjectKey) {
        payload.set(`${prefix}[price_data][product_data][metadata][original_object_key]`, item.originalObjectKey);
      }
      if (item.thumbnailObjectKey) {
        payload.set(`${prefix}[price_data][product_data][metadata][thumbnail_object_key]`, item.thumbnailObjectKey);
      }
    }
    payload.set(`${prefix}[price_data][unit_amount]`, String(item.unitAmount));
    payload.set(`${prefix}[quantity]`, String(item.quantity));
  });

  return payload;
}

async function createCheckoutSession(request, env) {
  if (!validateStripeConfiguration(env)) {
    return jsonResponse(request, env, { error: 'Checkout is not configured' }, 503);
  }

  if (!getAllowedOrigin(request, env)) {
    return jsonResponse(request, env, { error: 'Origin is not allowed' }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, env, { error: 'Request body must be valid JSON' }, 400);
  }

  let lineItems;
  try {
    lineItems = buildLineItems(body.items);
  } catch (error) {
    return jsonResponse(request, env, { error: error.message }, 400);
  }

  const siteBaseUrl = getSiteBaseUrl(env);
  if (!siteBaseUrl) {
    return jsonResponse(request, env, { error: 'Checkout is not configured' }, 503);
  }
  const stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: createStripePayload(lineItems, siteBaseUrl)
  });
  const stripeResult = await stripeResponse.json();

  if (!stripeResponse.ok) {
    console.error('Stripe checkout request failed', {
      status: stripeResponse.status,
      type: stripeResult?.error?.type,
      code: stripeResult?.error?.code
    });
    return jsonResponse(request, env, { error: 'Stripe could not create the checkout session' }, 502);
  }

  return jsonResponse(request, env, {
    id: stripeResult.id,
    url: stripeResult.url
  });
}

/*
 * =========================================================
 * STRIPE WEBHOOK -> ORDER CONFIRMATION EMAIL (via Resend)
 * =========================================================
 *
 * Fires on checkout.session.completed. Requires these to be configured
 * on the Worker (none of this lives in the repo - see the deploy notes
 * in this file's header comment / the project README):
 *
 *   wrangler secret put STRIPE_WEBHOOK_SECRET   (from the Stripe
 *     Dashboard webhook endpoint you create, see below)
 *   wrangler secret put RESEND_API_KEY          (from resend.com)
 *
 * And in wrangler.jsonc `vars` (not secret, just a from-address):
 *   RESEND_FROM_EMAIL  e.g. "Good Frame <orders@goodframe.com.au>"
 *     (the domain in this address must be a verified sender in Resend)
 *
 * Stripe Dashboard setup (Developers -> Webhooks -> Add endpoint):
 *   URL: https://<your-worker-subdomain>.workers.dev/stripe-webhook
 *   Event: checkout.session.completed
 *   Copy the generated "Signing secret" into STRIPE_WEBHOOK_SECRET.
 *
 * The email HTML itself is NOT duplicated here - it's fetched at
 * send-time from Checkout/payment-confirmation-email.html on the live
 * site (via SITE_BASE_URL) and its {{tokens}} are filled in below, so
 * editing that one file is enough to change what customers receive.
 */

async function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) {
    return false;
  }

  const parts = Object.fromEntries(
    signatureHeader.split(',').map(pair => {
      const [key, value] = pair.split('=');
      return [key, value];
    })
  );

  const timestamp = parts.t;
  const expectedSignature = parts.v1;
  if (!timestamp || !expectedSignature) {
    return false;
  }

  // Reject stale requests (5 minute tolerance, matches Stripe's own SDKs)
  // to guard against replayed webhook deliveries.
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`)
  );
  const computedSignature = [...new Uint8Array(signatureBuffer)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');

  return timingSafeEqualHex(computedSignature, expectedSignature);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatCurrency(amountInCents, currency) {
  const amount = (Number(amountInCents) || 0) / 100;
  try {
    return new Intl.NumberFormat('en-AU', {
      style: 'currency',
      currency: (currency || 'aud').toUpperCase()
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

async function fetchLineItems(sessionId, env) {
  const response = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${sessionId}/line_items?limit=100`,
    { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
  );

  if (!response.ok) {
    return [];
  }

  const data = await response.json();
  return Array.isArray(data.data) ? data.data : [];
}

function buildItemLabel(lineItems) {
  const framedItems = lineItems.filter(
    item => !(item.description || '').toLowerCase().includes('shipping')
  );

  if (framedItems.length === 0) {
    return 'Your order';
  }

  const name = framedItems[0].description || 'Print & Frame';
  return framedItems.length === 1
    ? name
    : `${name} + ${framedItems.length - 1} more`;
}

async function sendOrderConfirmationEmail(session, env) {
  if (!env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY is not configured - skipping confirmation email');
    return;
  }

  const customerEmail = session.customer_details?.email || session.customer_email;
  if (!customerEmail) {
    console.error('Checkout session has no customer email - skipping confirmation email');
    return;
  }

  const lineItems = await fetchLineItems(session.id, env);
  const orderNumber = session.client_reference_id
    ? `#GF-${session.client_reference_id}`
    : `#GF-${session.id.slice(-8).toUpperCase()}`;
  const itemName = buildItemLabel(lineItems);
  const totalPaid = formatCurrency(session.amount_total, session.currency);

  const siteBaseUrl = String(env.SITE_BASE_URL || 'https://goodframe.com.au').replace(/\/$/, '');
  const templateResponse = await fetch(`${siteBaseUrl}/Checkout/payment-confirmation-email.html`);
  if (!templateResponse.ok) {
    throw new Error(`Could not load email template (${templateResponse.status})`);
  }

  const supportEmail = env.SUPPORT_EMAIL || 'contact.goodframe@gmail.com';
  const trackOrderUrl = `mailto:${supportEmail}?subject=${encodeURIComponent(`Order tracking — ${orderNumber}`)}`;

  let html = await templateResponse.text();
  html = html
    .replaceAll('{{orderNumber}}', escapeHtml(orderNumber))
    .replaceAll('{{itemName}}', escapeHtml(itemName))
    .replaceAll('{{totalPaid}}', escapeHtml(totalPaid))
    .replaceAll('{{trackOrderUrl}}', trackOrderUrl)
    .replaceAll('{{homeUrl}}', `${siteBaseUrl}/`)
    .replaceAll('{{year}}', String(new Date().getFullYear()));

  const emailResponse = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL || 'Good Frame <orders@goodframe.com.au>',
      to: [customerEmail],
      subject: 'Your Good Frame order is confirmed',
      html
    })
  });

  if (!emailResponse.ok) {
    const errorText = await emailResponse.text();
    throw new Error(`Resend API error (${emailResponse.status}): ${errorText}`);
  }
}

async function handleStripeWebhook(request, env) {
  if (!validateStripeConfiguration(env) || !env.STRIPE_WEBHOOK_SECRET) {
    return new Response('Webhook secret is not configured', { status: 500 });
  }

  const rawBody = await request.text();
  const isValid = await verifyStripeSignature(
    rawBody,
    request.headers.get('Stripe-Signature'),
    env.STRIPE_WEBHOOK_SECRET
  );

  if (!isValid) {
    return new Response('Invalid signature', { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response('Invalid JSON payload', { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    try {
      await sendOrderConfirmationEmail(event.data.object, env);
    } catch (error) {
      // The payment already succeeded regardless of whether the email
      // goes out, so log and still acknowledge the webhook - returning
      // an error here would just make Stripe retry a delivery that will
      // fail the same way again (e.g. a bad API key), risking duplicate
      // emails on the deliveries that *do* succeed partway through.
      console.error('Order confirmation email failed:', error);
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: createCorsHeaders(request, env)
      });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse(request, env, { ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/create-checkout-session') {
      return createCheckoutSession(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/artwork/upload') {
      return uploadArtwork(request, env);
    }

    if (request.method === 'GET' && url.pathname.startsWith('/artwork/')) {
      try {
        const objectKey = url.pathname.slice('/artwork/'.length).split('/').map(decodeURIComponent).join('/');
        return getArtwork(request, env, objectKey);
      } catch {
        return new Response('Not found', { status: 404 });
      }
    }

    if (request.method === 'POST' && url.pathname === '/stripe-webhook') {
      return handleStripeWebhook(request, env);
    }

    return jsonResponse(request, env, { error: 'Not found' }, 404);
  }
};
