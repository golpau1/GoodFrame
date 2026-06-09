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

  return Object.keys(PRICE_BY_SIZE).find(size => {
    const [canonicalWidth, canonicalHeight] = size
      .replace('mm', '')
      .split('x')
      .map(Number);

    return (
      (width === canonicalWidth && height === canonicalHeight) ||
      (width === canonicalHeight && height === canonicalWidth)
    );
  }) || null;
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
      orderCode ? `Code #${orderCode}` : '',
      cleanText(item.orientation, ''),
      item.frameColor ? `${cleanText(item.frameColor, '')} Frame` : '',
      cleanText(item.border, '')
    ].filter(Boolean).join(' | ') || 'Custom framed print';

    subtotal += unitAmount * quantity;
    lineItems.push({
      name: orderCode ? `#${orderCode} - Print & Frame - ${size}` : `Print & Frame - ${size}`,
      description,
      unitAmount,
      quantity,
      orderCode,
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
    payload.set('payment_intent_data[description]', `Good Frame ${orderCodeMetadataValue}`);
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
    }
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
