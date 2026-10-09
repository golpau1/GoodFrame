import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProductCodeError,
  beginCheckoutRequest,
  completeCheckoutRequest,
  findProductCode,
  getProductCodeCapacity,
  markProductCodesPaid,
  randomProductCode,
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
