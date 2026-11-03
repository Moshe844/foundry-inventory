'use strict';

const { ValidationError } = require('../domain/errors');

/**
 * What goes in one carrier parcel for an order: every committed unit, kits as
 * whole kits, all from one dispatch location. Used by "Start picking" and by
 * "Get shipping rates" on the order page, so both open the same parcel.
 */
function forParcel(detail) {
  if (detail.order.delivery_method !== 'SHIP') throw new ValidationError(
    'Pickup orders do not need a carrier parcel. Use “Record what physically left” when the customer collects it.');
  const lines = detail.lines.flatMap((line) => line.allocations.map((allocation) => ({ lineId: line.id,
    locationId: allocation.location_id, quantity: Number(allocation.quantity) })));
  for (const line of detail.lines.filter((l) => l.kitReady > 0)) {
    const places = [...new Set(line.kitComponents.flatMap((p) => p.allocations.map((a) => a.location_id)))];
    const place = places.find((id) => line.kitComponents.every((p) => p.allocations.filter((a) => a.location_id === id)
      .reduce((n, a) => n + a.quantity, 0) + 1e-9 >= line.kitReady * Number(p.quantity_per_kit)));
    if (!place) throw new ValidationError('The kit components are reserved across locations. Move them to one dispatch location for a carrier parcel, or record the exact goods leaving each location below.');
    lines.push({ lineId: line.id, locationId: place, quantity: line.kitReady, kit: true });
  }
  if (!lines.length) throw new ValidationError('There is no committed stock ready to pick.');
  const locationId = lines[0].locationId;
  if (lines.some((line) => line.locationId !== locationId)) throw new ValidationError(
    'This order is held at more than one location. Prepare one shipment from each location.');
  return { lines, locationId };
}

module.exports = { forParcel };
