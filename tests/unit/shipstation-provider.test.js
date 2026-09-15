'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const shipstation = require('../../src/shipping/providers/shipstation');

test('ShipStation V2 provides carrier rates, labels, tracking and voids in Foundry vocabulary', async () => {
  const previous = global.fetch;
  const calls = [];
  const replies = [
    { carriers: [{ carrier_id: 'se-carrier' }] },
    { shipment_id: 'se-shipment', rate_response: { rates: [{ rate_id: 'se-rate',
      carrier_code: 'ups', service_type: 'UPS Ground', shipping_amount: { amount: 12.34, currency: 'usd' },
      delivery_days: 3, estimated_delivery_date: '2026-09-20T00:00:00Z' }] } },
    { label_id: 'se-label', shipment_id: 'se-shipment', carrier_code: 'ups', service_code: 'ups_ground',
      tracking_number: '1ZTEST', tracking_url: 'https://carrier.example/1ZTEST',
      label_download: { pdf: 'https://api.shipstation.com/label.pdf' }, label_format: 'pdf',
      shipment_cost: { amount: 12.34, currency: 'usd' } },
    { tracking_number: '1ZTEST', status_code: 'DE', status_description: 'Delivered',
      events: [{ event_code: 'DE', status_code: 'DE', description: 'Delivered',
        occurred_at: '2026-09-20T14:00:00Z' }] },
    { approved: true, message: 'Label voided' },
  ];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const body = replies.shift();
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  try {
    const ctx = { shipstationApiKey: 'TEST_owned-by-this-business' };
    const quoted = await shipstation.quote(ctx, { from: { postalCode: '10001' },
      to: { postalCode: '90210' }, packages: [{ weightGrams: 500 }] });
    assert.equal(quoted.rates[0].amountMinor, 1234);
    assert.equal(quoted.rates[0].carrier, 'ups');

    const bought = await shipstation.buy(ctx, { rateId: 'se-rate', idempotencyKey: 'foundry-effect-1' });
    assert.deepEqual(bought.providerLabelIds, ['se-label']);
    assert.equal(bought.trackingNumber, '1ZTEST');

    const tracked = await shipstation.track(ctx, { providerShipmentId: 'se-label', carrier: 'ups' });
    assert.equal(tracked.status, 'DELIVERED');
    assert.equal(tracked.events[0].status, 'DELIVERED');

    const voided = await shipstation.voidLabel(ctx, { providerReferences: ['se-label'] });
    assert.equal(voided.status, 'SUCCEEDED');
    assert.ok(calls.every((call) => call.url.startsWith('https://api.shipstation.com/v2/')));
    assert.ok(calls.every((call) => call.options.headers['API-Key'] === 'TEST_owned-by-this-business'));
    assert.equal(calls[1].url, 'https://api.shipstation.com/v2/rates');
    assert.equal(calls[2].url, 'https://api.shipstation.com/v2/labels/rates/se-rate');
    assert.equal(calls[3].url, 'https://api.shipstation.com/v2/labels/se-label/track');
    assert.equal(calls[4].url, 'https://api.shipstation.com/v2/labels/se-label/void');
  } finally {
    global.fetch = previous;
  }
});
