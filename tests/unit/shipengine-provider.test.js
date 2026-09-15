'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const shipengine = require('../../src/shipping/providers/shipengine');

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body === null ? '' : JSON.stringify(body),
    json: async () => body,
  };
}

test('ShipEngine translates carrier rates and labels without leaking provider shapes', async () => {
  const calls = [];
  const held = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/v1/carriers')) return response({ carriers: [
      { carrier_id: 'se-carrier', carrier_code: 'stamps_com' },
    ] });
    if (url.endsWith('/v1/rates')) return response({
      shipment_id: 'se-shipment',
      rate_response: { rates: [{
        rate_id: 'se-rate', carrier_code: 'stamps_com', service_type: 'USPS Ground Advantage',
        shipping_amount: { amount: 8.42, currency: 'usd' }, delivery_days: 3,
        estimated_delivery_date: '2026-09-10T00:00:00Z', guaranteed_service: false,
      }] },
    });
    if (url.includes('/v1/labels/rates/')) return response({
      label_id: 'se-label', shipment_id: 'se-shipment', carrier_code: 'stamps_com',
      service_code: 'usps_ground_advantage', tracking_number: '9400000000000000000000',
      shipment_cost: { amount: 8.42, currency: 'usd' }, label_format: 'pdf',
      label_download: { pdf: 'https://labels.example/label.pdf' },
    });
    if (url.endsWith('/v1/labels/se-label/void')) {
      return response({ approved: true, message: 'Label voided and refund requested.' });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    const ctx = { shipengineApiKey: 'TEST_seller-only' };
    const quoted = await shipengine.quote(ctx, {
      from: { name: 'Shop', line1: '1 Main St', city: 'Monroe', state: 'NY', postalCode: '10950' },
      to: { name: 'Customer', line1: '2 Oak St', city: 'Austin', state: 'TX', postalCode: '78701' },
      packages: [{ weightGrams: 500 }],
    });
    assert.deepEqual(quoted, { providerShipmentIds: ['se-shipment'], rates: [{
      rateId: 'se-rate', carrier: 'stamps_com', service: 'USPS Ground Advantage',
      amountMinor: 842, currency: 'USD', deliveryDays: 3,
      deliveryDate: '2026-09-10', guaranteed: false,
    }] });
    const rateRequest = JSON.parse(calls[1].options.body);
    assert.deepEqual(rateRequest.rate_options.carrier_ids, ['se-carrier']);
    assert.equal(rateRequest.shipment.packages[0].weight.unit, 'gram');

    const bought = await shipengine.buy(ctx, { rateId: 'se-rate' });
    assert.equal(bought.labelUrl, 'https://labels.example/label.pdf');
    assert.equal(bought.trackingNumber, '9400000000000000000000');
    assert.equal(bought.amountMinor, 842);
    assert.deepEqual(bought.providerLabelIds, ['se-label']);
    const voided = await shipengine.voidLabel(ctx, { providerReferences: bought.providerLabelIds });
    assert.equal(voided.status, 'SUCCEEDED');
    assert.deepEqual(voided.references, ['se-label']);
    assert.match(voided.detail, /refund requested/i);
    assert.ok(calls.every((call) => call.options.headers['api-key'] === 'TEST_seller-only'),
      'every carrier call uses the workspace seller key');
  } finally { global.fetch = held; }
});

test('ShipEngine webhooks require a fresh valid RSA signature', async () => {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  jwk.kid = 'test-kid';
  const body = Buffer.from(JSON.stringify({
    resource_type: 'API_TRACK',
    data: { tracking_number: '9400', status_code: 'IT', events: [] },
  }));
  const timestamp = new Date().toISOString();
  const signature = crypto.sign('RSA-SHA256',
    Buffer.concat([Buffer.from(`${timestamp}.`), body]), pair.privateKey).toString('base64');
  const event = await shipengine.verifyEvent(body, {
    'x-shipengine-rsa-sha256-key-id': 'test-kid',
    'x-shipengine-rsa-sha256-signature': signature,
    'x-shipengine-timestamp': timestamp,
  }, { jwks: [jwk] });
  assert.equal(shipengine.readEvent(event).status, 'IN_TRANSIT');

  await assert.rejects(shipengine.verifyEvent(Buffer.from('{}'), {
    'x-shipengine-rsa-sha256-key-id': 'test-kid',
    'x-shipengine-rsa-sha256-signature': signature,
    'x-shipengine-timestamp': timestamp,
  }, { jwks: [jwk] }), /signature is not valid/i);
});

test('ShipEngine refreshes rotated webhook keys and returns safe signature status codes', async () => {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  jwk.kid = 'rotated-kid';
  const body = Buffer.from('{"resource_type":"API_TRACK","data":{"tracking_number":"9401"}}');
  const timestamp = new Date().toISOString();
  const signature = crypto.sign('RSA-SHA256',
    Buffer.concat([Buffer.from(`${timestamp}.`), body]), pair.privateKey).toString('base64');
  let reads = 0;
  const fakeFetch = async () => {
    reads += 1;
    return response({ keys: reads === 1 ? [] : [jwk] });
  };

  const event = await shipengine.verifyEvent(body, {
    'x-shipengine-rsa-sha256-key-id': 'rotated-kid',
    'x-shipengine-rsa-sha256-signature': signature,
    'x-shipengine-timestamp': timestamp,
  }, { fetch: fakeFetch });
  assert.equal(event.data.tracking_number, '9401');
  assert.equal(reads, 2, 'an unfamiliar key causes one immediate JWKS refresh');

  await assert.rejects(async () => {
    try { await shipengine.verifyEvent(body, {}, { jwks: [jwk] }); }
    catch (error) { assert.equal(error.status, 404); throw error; }
  }, /did not carry ShipEngine's signature/);
});
