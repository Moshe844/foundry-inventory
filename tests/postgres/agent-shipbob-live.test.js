'use strict';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const routes = require('../../src/connections/agent-3pl-orders');

test('ShipBob production pilot stays inventory-scoped, follows each tier and reconciles an unconfirmed submit',
  { timeout: 240000 }, async t => {
    const f = await require('../helpers/agent-workflow-fixture').fixture(t, { units: 25 });
    const { db, ctx, subscribe, workflows } = f;
    const workspaceId = ctx.workspaceId;
    const envKeys = ['STOCKCHIEF_RUNTIME_ENV', 'STOCKCHIEF_SHIPBOB_LIVE_WORKSPACES'];
    const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    t.after(() => {
      for (const key of envKeys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
    const input = { provider: 'shipbob-live', account: '743', apiKey: 'synthetic-live-token' };
    const skuId = f.item.skuIds[0];
    const { code } = (await db.query('SELECT code FROM skus WHERE workspace_id=$1 AND id=$2', [workspaceId, skuId])).rows[0];
    const orders = new Map();
    let reads = 0, submissions = 0, lostResponse = false, temporarilyInvisible = false, beforeLookup;
    const respond = body => new Response(JSON.stringify(body), { status: 200 });
    const transport = async (url, opts) => {
      assert.equal(new URL(url).origin, 'https://api.shipbob.com');
      assert.equal(opts.headers.Authorization, 'Bearer synthetic-live-token');
      assert.equal(opts.headers.shipbob_channel_id, '743');
      const target = new URL(url);
      reads++;
      if (target.pathname.endsWith('/channel')) return respond({
        items: [{ id: 743, scopes: ['channels_read', 'orders_read', 'orders_write', 'inventory_read'] }],
      });
      if (target.pathname.endsWith('/inventory-level/10')) return respond({
        inventory_id: 10, sku: code, total_on_hand_quantity: 14, total_fulfillable_quantity: 12,
      });
      if (opts.method === 'POST') {
        const payload = JSON.parse(opts.body);
        assert(!orders.has(payload.reference_id), 'No second creation of an existing order');
        const order = { ...payload, id: 700 + submissions++, channel: { id: 743 }, status: 'Processing', shipments: [] };
        orders.set(order.reference_id, order);
        if (lostResponse) {
          lostResponse = false;
          throw new Error('Fixture lost the response');
        }
        return respond(order);
      }
      if (target.searchParams.has('ReferenceIds')) {
        if (beforeLookup) {
          const perform = beforeLookup;
          beforeLookup = null;
          await perform();
        }
        const order = orders.get(target.searchParams.get('ReferenceIds'));
        return respond(order && !temporarilyInvisible ? [order] : []);
      }
      return respond([...orders.values()].find(order => target.pathname.endsWith('/order/' + order.id)));
    };
    async function sale() {
      const order = await workflows.createSalesOrder(db, ctx, {
        customerId: 'fixture-customer', deliveryMethod: 'SHIP', fulfillmentLocationId: f.location.id,
        idempotencyKey: randomUUID(), lines: [{ skuId, quantity: 2, unitPriceMinor: 1000 }],
      });
      await workflows.confirmSalesOrder(db, ctx, order.salesOrderId, { idempotencyKey: randomUUID() });
      return order.salesOrderId;
    }
    const run = () => routes.run(db, workspaceId, { transport, fresh: true });
    const shipped = id => {
      const order = orders.get(id);
      order.shipments = [{ id: 900 + order.id, status: 'Shipped',
        actual_fulfillment_date: new Date().toISOString(),
        tracking: { carrier: 'UPS', tracking_number: 'SYNTH-' + order.id },
        products: [{ reference_id: code, inventory_items: [{ quantity: 2 }] }],
      }];
    };

    process.env.STOCKCHIEF_SHIPBOB_LIVE_WORKSPACES = workspaceId;
    process.env.STOCKCHIEF_RUNTIME_ENV = 'production';
    await subscribe('starter');
    await assert.rejects(routes.connect(db, ctx, input, transport), e => e.code === 'entitlement_required');
    await subscribe('growth');
    process.env.STOCKCHIEF_RUNTIME_ENV = 'staging';
    await assert.rejects(routes.connect(db, ctx, input, transport), /unavailable in this inventory/);
    assert.equal(reads, 0);
    process.env.STOCKCHIEF_RUNTIME_ENV = 'production';
    process.env.STOCKCHIEF_SHIPBOB_LIVE_WORKSPACES = 'another-inventory';
    await assert.rejects(routes.connect(db, ctx, input, transport), /unavailable in this inventory/);
    assert.equal(reads, 0);
    process.env.STOCKCHIEF_SHIPBOB_LIVE_WORKSPACES = workspaceId;
    await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1", [f.owner.accountId]);
    await require('../../src/autopilot/postgres-service').setMode(db, ctx, { role: 'owner' }, 'POLICY_AUTOMATED');
    const { connectorId } = await routes.connect(db, ctx, input, transport);
    const rule = { locationId: f.location.id, connectorId };
    await assert.rejects(routes.saveRoute(db, ctx, { ...rule, automatic: 'yes' }), e => e.code === 'entitlement_required');
    await routes.saveRoute(db, ctx, rule);
    const growth = await sale();
    assert.equal((await run()).drafted, 1);
    assert.equal(submissions, 0);
    await routes.approve(db, ctx, growth, { transport });
    shipped(growth);
    assert.equal((await run()).waiting, 1);
    assert.equal(await f.balance(), 25);
    await routes.record(db, ctx, connectorId, String(900 + orders.get(growth).id));
    assert.equal(await f.balance(), 23);

    await subscribe('pro');
    await routes.saveRoute(db, ctx, { ...rule, revision: 1, automatic: 'yes' });
    const pro = await sale();
    assert.equal((await run()).sent, 1);
    shipped(pro);
    assert.equal((await run()).recorded, 1);
    assert.equal(await f.balance(), 21);
    assert.deepEqual(await routes.readStock(db, ctx, { connectorId, sku: code, inventoryRef: '10' }, transport),
      { onHand: 14, available: 12 });

    await subscribe('enterprise');
    const custom = await sale();
    lostResponse = true;
    assert.equal((await run()).held, 1);
    assert.equal(submissions, 3);
    temporarilyInvisible = true;
    await assert.rejects(routes.approve(db, ctx, custom, { transport }), /already tried to send/);
    assert.equal(submissions, 3);
    temporarilyInvisible = false;
    await routes.approve(db, ctx, custom, { transport });
    shipped(custom);
    assert.equal((await run()).recorded, 1);
    assert.equal(await f.balance(), 19);
    assert.equal(submissions, 3);

    const changed = await sale();
    beforeLookup = () => subscribe('starter');
    assert.equal((await run()).held, 1);
    assert(!orders.has(changed));
    assert.equal(submissions, 3);
    await subscribe('enterprise');
    process.env.STOCKCHIEF_SHIPBOB_LIVE_WORKSPACES = '';
    assert.equal((await routes.connections(db, workspaceId)).length, 0);
    const priorReads = reads;
    assert.equal((await run()).skipped, 1);
    assert.equal(reads, priorReads);
  });
