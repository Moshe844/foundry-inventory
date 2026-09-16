'use strict';

/*
 * A carrier that behaves like a carrier, without being one.
 *
 * The point of the shipping seam is that everything above it works from five
 * functions and StockChief's own vocabulary. So the tests exercise the whole
 * operation — rates, choosing, buying, tracking, delivery, exceptions —
 * against a provider that answers the way EasyPost does, and never touch the
 * network. If the seam were leaky this file would be impossible to write.
 */

function fakeCarrier(options = {}) {
  const state = { bought: [], voided: [], quoted: 0, trackers: new Map() };

  const rates = options.rates || [
    { rateId: 'rate_ups', carrier: 'ups', service: 'Ground', amountMinor: 1842,
      currency: 'USD', deliveryDays: 3, deliveryDate: '2026-09-14', guaranteed: false },
    { rateId: 'rate_fedex', carrier: 'fedex', service: 'Ground', amountMinor: 2110,
      currency: 'USD', deliveryDays: 3, deliveryDate: '2026-09-14', guaranteed: true },
    { rateId: 'rate_usps', carrier: 'usps', service: 'Priority Mail', amountMinor: 1680,
      currency: 'USD', deliveryDays: 4, deliveryDate: '2026-09-15', guaranteed: false },
  ];

  return {
    state,
    isConfigured: () => true,
    async quote() {
      state.quoted += 1;
      return { providerShipmentIds: ['shp_fake'], rates };
    },
    async buy(ctx, input) {
      if (options.buyError) throw options.buyError;
      const rate = rates.find((row) => (input.rateIds || []).includes(row.rateId)) || rates[0];
      state.bought.push(rate.rateId);
      return {
        providerShipmentId: 'shp_fake',
        providerShipmentIds: ['shp_fake'],
        providerLabelIds: ['lbl_fake'],
        carrier: rate.carrier,
        service: rate.service,
        trackingNumber: options.trackingNumber || '1Z999AA10123456784',
        trackingUrl: 'https://carrier.test/track/1Z999AA10123456784',
        labelUrl: 'https://carrier.test/labels/shp_fake.pdf',
        labelFormat: 'PDF',
        amountMinor: rate.amountMinor,
        currency: rate.currency,
        deliveryDate: rate.deliveryDate,
      };
    },
    async voidLabel(ctx, input) {
      state.voided.push(...(input.providerReferences || []));
      if (options.voidError) throw options.voidError;
      return { status: options.voidStatus || 'SUCCEEDED',
        references: input.providerReferences || [], detail: options.voidDetail || 'Unused label refunded.' };
    },
    async track(ctx, input) {
      return state.trackers.get(input.trackingNumber) || null;
    },
    verifyEvent(raw) {
      return JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
    },
    readEvent(event = {}) {
      const result = event.result || {};
      return {
        externalEventId: event.id || null,
        type: event.description || null,
        providerShipmentId: result.shipment_id || null,
        trackingNumber: result.tracking_code || null,
        carrier: result.carrier || null,
        status: result.status || 'UNKNOWN',
        detail: result.status_detail || null,
        estimatedDeliveryDate: result.est_delivery_date || null,
        events: (result.tracking_details || []).map((entry, index) => ({
          externalEventId: entry.object_id || `scan_${index}`,
          status: entry.status,
          detail: entry.message || null,
          location: entry.location || null,
          occurredAt: entry.datetime,
        })),
      };
    },
  };
}

/** One carrier message, in the shape a webhook delivers. */
function carrierEvent(input = {}) {
  return {
    id: input.id || 'evt_fake_1',
    description: input.description || 'tracker.updated',
    result: {
      shipment_id: 'shp_fake',
      tracking_code: input.trackingNumber || '1Z999AA10123456784',
      carrier: input.carrier || 'ups',
      status: input.status || 'IN_TRANSIT',
      status_detail: input.detail || null,
      est_delivery_date: input.estimatedDeliveryDate || null,
      tracking_details: input.events || [],
    },
  };
}

module.exports = { fakeCarrier, carrierEvent };
