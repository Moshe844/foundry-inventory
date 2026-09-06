'use strict';

/*
 * Where parcels leave from.
 *
 * A carrier will not quote a rate without an origin, and Foundry will not
 * invent one — so the address has to be somewhere a person can type it. It is
 * optional, because most locations never post anything and a stockroom does
 * not need a postal address to hold stock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const locations = require('../../src/domain/location-service');
const shipping = require('../../src/shipping');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'HalFi Shoes' });
  return { db, workspace, ctx: workspace.ctx };
}

test('a location can be given a postal address, and does not need one', () => {
  const env = setup();
  const posts = locations.createLocation(env.db, env.ctx, {
    name: 'Dispatch', kind: 'warehouse', address: '12 Depot Road\nMonroe, NY 10950',
  });
  assert.equal(posts.address, '12 Depot Road\nMonroe, NY 10950');

  const holds = locations.createLocation(env.db, env.ctx, { name: 'Back room', kind: 'stockroom' });
  assert.equal(holds.address, null, 'a stockroom does not need an address to hold stock');
  env.db.close();
});

test('renaming a location does not quietly erase where its parcels leave from', () => {
  /*
   * The edit form is also the rename form. An address cleared by a field that
   * simply was not on the page would stop every parcel shipping from that
   * location, and say nothing about it.
   */
  const env = setup();
  const made = locations.createLocation(env.db, env.ctx, {
    name: 'Dispatch', kind: 'warehouse', address: '12 Depot Road, Monroe, NY 10950',
  });

  const renamed = locations.updateLocation(env.db, env.ctx, made.id,
    { name: 'Main dispatch', kind: 'warehouse' });
  assert.equal(renamed.address, '12 Depot Road, Monroe, NY 10950');

  // Emptied on purpose is a different thing, and is honoured.
  const cleared = locations.updateLocation(env.db, env.ctx, made.id,
    { name: 'Main dispatch', kind: 'warehouse', address: '' });
  assert.equal(cleared.address, null);
  env.db.close();
});

test('the address a person types is the one a carrier is asked to collect from', () => {
  /*
   * The point of the field. Until this existed, readiness reported that
   * Foundry had no address for the location and no rate could be asked for.
   */
  const env = setup();
  const made = locations.createLocation(env.db, env.ctx, {
    name: 'Dispatch', kind: 'warehouse', address: '12 Depot Road, Monroe, NY 10950',
  });
  const parsed = shipping.address.parse(
    env.db.prepare('SELECT address FROM locations WHERE id = ?').get(made.id).address);
  assert.equal(parsed.complete, true, 'a carrier can be asked to collect from this');
  assert.equal(parsed.city, 'Monroe');
  assert.equal(parsed.state, 'NY');
  assert.equal(parsed.postalCode, '10950');
  env.db.close();
});
