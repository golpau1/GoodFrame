const PRICE_BY_SIZE = Object.freeze({
  '300x200mm': 9900,
  '600x400mm': 23500,
  '900x600mm': 35000,
  '1200x800mm': 70000
});

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

function cleanText(value, fallback) {
  const text = typeof value === 'string' ? value : fallback;
  return text.replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
}

function buildLineItems(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 20) {
    throw new Error('Cart must contain between 1 and 20 items');
  }

  const lineItems = [];
  let subtotal = 0;

  items.forEach(item => {
    const size = typeof item?.size === 'string' ? item.size : '';
    const unitAmount = PRICE_BY_SIZE[size];

    if (!unitAmount) {
      throw new Error('One or more cart items has an invalid frame size');
    }

    const requestedQuantity = Number(item.quantity);
    const quantity = Number.isInteger(requestedQuantity)
      ? Math.min(Math.max(requestedQuantity, 1), 10)
      : 1;
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
      quantity
    });
  });

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
  const payload = new URLSearchParams({
    mode: 'payment',
    success_url: `${siteBaseUrl}/Checkout/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteBaseUrl}/cart.html`,
    billing_address_collection: 'required',
    'shipping_address_collection[allowed_countries][0]': 'AU',
    'shipping_address_collection[allowed_countries][1]': 'US',
    'shipping_address_collection[allowed_countries][2]': 'BR'
  });

  lineItems.forEach((item, index) => {
    const prefix = `line_items[${index}]`;
    payload.set(`${prefix}[price_data][currency]`, 'aud');
    payload.set(`${prefix}[price_data][product_data][name]`, item.name);
    payload.set(`${prefix}[price_data][product_data][description]`, item.description);
    payload.set(`${prefix}[price_data][unit_amount]`, String(item.unitAmount));
    payload.set(`${prefix}[quantity]`, String(item.quantity));
  });

  return payload;
}

async function createCheckoutSession(request, env) {
  if (!env.STRIPE_SECRET_KEY) {
    return jsonResponse(request, env, { error: 'Stripe secret is not configured' }, 500);
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

  const siteBaseUrl = String(env.SITE_BASE_URL || 'https://golpau1.github.io/GoodFrame').replace(/\/$/, '');
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
    const message = stripeResult?.error?.message || 'Stripe could not create the checkout session';
    return jsonResponse(request, env, { error: message }, stripeResponse.status);
  }

  return jsonResponse(request, env, {
    id: stripeResult.id,
    url: stripeResult.url
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

    return jsonResponse(request, env, { error: 'Not found' }, 404);
  }
};
