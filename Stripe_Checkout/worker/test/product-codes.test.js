import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProductCodeError,
  attachProductPdf,
  beginCheckoutRequest,
  completeCheckoutRequest,
  findProductCode,
  getProductCodeCapacity,
  markProductCodesPaid,
  randomProductCode,
  reserveCartProductCode,
  reserveProductCodes
} from '../src/product-codes.js';
import { createProductCodeDatabase } from './helpers/d1.js';

const requestId = 'co_0123456789abcdef0123456789abcdef';

function units(quantity = 3) {
  return Array.from({ length:quantity }, (_, unitIndex) => ({
    cartItemId:'ci_0123456789abcdef0123456789abcdef',
    unitIndex,
    productType:'tiny_frame_only',
    uploadReference:'',
    unitAmount:7000,
    quantity:1
  }));
}

test('random product codes are exactly five non-sequential numerical digits', () => {
  const samples = new Set(Array.from({ length:100 }, () => randomProductCode()));
  assert.equal([...samples].every(code => /^[1-9][0-9]{4}$/.test(code)), true);
  assert.equal(samples.size > 90, true);
});

test('database uniqueness gives each physical unit a different durable code', async () => {
  const database = createProductCodeDatabase();
  const first = await reserveProductCodes(database, units(), requestId);
  assert.equal(first.units.length, 3);
  assert.equal(new Set(first.units.map(item => item.productCode)).size, 3);
  assert.equal(first.units.every(item => /^[1-9][0-9]{4}$/.test(item.productCode)), true);

  const retry = await reserveProductCodes(database, units(), requestId);
  assert.deepEqual(
    retry.units.map(item => item.productCode),
    first.units.map(item => item.productCode)
  );
  assert.deepEqual(await getProductCodeCapacity(database), {
    used:3,
    remaining:89997,
    capacity:90000,
    low:false,
    exhausted:false
  });
  database.close();
});

test('collisions retry and previously assigned codes are never reused', async () => {
  const database = createProductCodeDatabase();
  const values = [0, 0, 1];
  const randomValues = output => { output[0] = values.shift() ?? 2; };
  const first = await reserveProductCodes(database, units(1), requestId, { randomValues });
  const second = await reserveProductCodes(database, [{
    ...units(1)[0],
    cartItemId:'ci_fedcba9876543210fedcba9876543210'
  }], 'co_fedcba9876543210fedcba9876543210', { randomValues });
  assert.equal(first.units[0].productCode, '10000');
  assert.equal(second.units[0].productCode, '10001');
  database.close();
});

test('pre-upload reservation keeps one code when its product PDF is attached and checkout begins', async () => {
  const database = createProductCodeDatabase();
  const cartItemId = 'ci_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const first = await reserveCartProductCode(database, {
    cartItemId,
    productType:'tiny_frame_8_pictures'
  });
  const retry = await reserveCartProductCode(database, {
    cartItemId,
    productType:'tiny_frame_8_pictures'
  });
  assert.equal(retry.productCode, first.productCode);
  const objectKey = `${first.productCode}/${first.productCode}-print-sheet.pdf`;
  await attachProductPdf(database, first.productCode, cartItemId, objectKey);
  const checkout = await reserveProductCodes(database, [{
    cartItemId,
    unitIndex:0,
    productType:'tiny_frame_8_pictures',
    uploadReference:objectKey
  }], 'co_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(checkout.units[0].productCode, first.productCode);
  const record = await findProductCode(database, first.productCode);
  assert.equal(record.upload_session_id, objectKey);
  assert.equal(record.checkout_request_id, 'co_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  database.close();
});

test('previous code-based PDF paths remain attached to their original products', async () => {
  const database = createProductCodeDatabase();
  const cartItemId = 'ci_cccccccccccccccccccccccccccccccc';
  const reservation = await reserveCartProductCode(database, {
    cartItemId,
    productType:'tiny_frame_8_pictures'
  });
  const previousObjectKey = `tinyframes/products/${reservation.productCode}/print-sheet-${reservation.productCode}.pdf`;
  await attachProductPdf(database, reservation.productCode, cartItemId, previousObjectKey);
  const record = await findProductCode(database, reservation.productCode);
  assert.equal(record.upload_session_id, previousObjectKey);
  database.close();
});

test('preferred cart codes use the database uniqueness constraint and report collisions', async () => {
  const database = createProductCodeDatabase();
  const first = await reserveCartProductCode(database, {
    cartItemId:'ci_dddddddddddddddddddddddddddddddd',
    productType:'tiny_frame_only'
  }, { preferredCode:'58321' });
  assert.equal(first.productCode, '58321');
  await assert.rejects(
    reserveCartProductCode(database, {
      cartItemId:'ci_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      productType:'tiny_frame_only'
    }, { preferredCode:'58321' }),
    error => error instanceof ProductCodeError && error.code === 'PRODUCT_CODE_COLLISION'
  );
  database.close();
});

test('checkout retries preserve codes and paid Stripe relationships are searchable', async () => {
  const database = createProductCodeDatabase();
  const allocation = await reserveProductCodes(database, units(1), requestId);
  const code = allocation.units[0].productCode;
  const payloadHash = 'a'.repeat(64);
  await beginCheckoutRequest(database, requestId, payloadHash, [code]);
  await completeCheckoutRequest(database, requestId, {
    id:'cs_live_productcode1',
    url:'https://checkout.stripe.com/c/pay/example'
  });
  await markProductCodesPaid(database, {
    id:'cs_live_productcode1',
    payment_intent:'pi_live_productcode1'
  });
  await markProductCodesPaid(database, {
    id:'cs_live_productcode1',
    payment_intent:'pi_live_productcode1'
  });
  const record = await findProductCode(database, code);
  assert.equal(record.status, 'paid');
  assert.equal(record.stripe_checkout_session_id, 'cs_live_productcode1');
  assert.equal(record.stripe_payment_intent_id, 'pi_live_productcode1');
  database.close();
});

test('checkout request IDs cannot be reused for changed product sets', async () => {
  const database = createProductCodeDatabase();
  const allocation = await reserveProductCodes(database, units(1), requestId);
  await beginCheckoutRequest(database, requestId, 'a'.repeat(64), [allocation.units[0].productCode]);
  await assert.rejects(
    beginCheckoutRequest(database, requestId, 'b'.repeat(64), [allocation.units[0].productCode]),
    ProductCodeError
  );
  database.close();
});
