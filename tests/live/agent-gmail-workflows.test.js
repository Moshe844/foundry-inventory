'use strict';

process.env.NODE_ENV = 'test';
process.env.FOUNDRY_PUBLIC_URL = 'https://stockchief.example.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const gmail = require('../../src/connections/providers/gmail');
const workflows = require('../../src/operations/postgres-business-workflows');
const queue = require('../../src/operations/postgres-job-queue');
const outbound = require('../../src/connections/postgres-outbound-mail');
const autopilot = require('../../src/autopilot/postgres-service');
const ownership = require('../../src/operations/postgres-workflow-ownership');
const confirmations = require('../../src/purchasing/agent-supplier-ship-promises');
const chases = require('../../src/purchasing/agent-supplier-delivery-chases');
const links = require('../../src/purchasing/supplier-order-link');
const store = require('../../src/connections/postgres-credential-store');
const supplierId = 'fixture-supplier';
const member = { role: 'owner' };
const confirmedLogin = process.env.STOCKCHIEF_GMAIL_FIXTURE_OWNER;

async function verifiedGrant() {
  const settings = require('node:util').parseEnv(fs.readFileSync(process.env.STOCKCHIEF_GMAIL_FIXTURE_CONFIG, 'utf8'));
  const url = new URL(settings.FOUNDRY_DATABASE_URL);
  assert.equal(url.hostname, 'dpg-damlkhuk1f9s739h5ga0-a.virginia-postgres.render.com');
  assert.equal(url.pathname, '/stockchief_staging');
  url.searchParams.set('sslmode', 'verify-full');
  const staging = require('../../src/db/postgres').openPostgres(url.href, { max: 1, applicationName: 'stockchief-gmail-fixture-readonly' });
  try {
    const { connection, grant } = await staging.transaction(async client => {
      const result = await client.query(`SELECT c.workspace_id,c.id,c.provider_account_id
        FROM workspace_connectors c
        WHERE c.provider_type='gmail' AND c.status='connected' AND c.setup_status='CONNECTED'
          AND c.paused_at IS NULL AND c.capabilities::jsonb ? 'MAIL_SEND'
          AND EXISTS(SELECT 1 FROM users u JOIN accounts a ON a.id=u.account_id
            WHERE u.workspace_id=c.workspace_id AND u.role='owner' AND lower(a.email)=lower($1))`, [confirmedLogin]);
      assert.equal(result.rows.length, 1, 'Exactly one send-capable Gmail connection must belong to the approved staging login.');
      const connection = result.rows[0];
      const sealed = (await client.query(`SELECT ciphertext,iv,auth_tag FROM connection_credentials
        WHERE workspace_id=$1 AND connector_id=$2 AND credential_kind='provider'`, [connection.workspace_id, connection.id])).rows[0];
      const key = require('node:crypto').createHash('sha256').update(settings.FOUNDRY_CONNECTION_ENCRYPTION_KEY).digest();
      const { accessToken, expiresAt, scope } = require('../../src/connections/credentials').decrypt(sealed, key);
      return { connection, grant: { accessToken, expiresAt, scope } };
    }, { readOnly: true, statementTimeoutMs: 10000 });
    assert.ok(Number(grant.expiresAt) > Date.now() + 5 * 60000, 'Refresh the approved connection before running the fixture.');
    const { body: profile } = await gmail.api(grant, '/gmail/v1/users/me/profile', { retries: 0 });
    const recipient = profile.emailAddress.toLowerCase();
    assert.ok(recipient.endsWith('@gmail.com'));
    assert.ok(recipient === connection.provider_account_id.toLowerCase(), 'The Google profile must match the selected connection.');
    return { grant, recipient };
  } finally {
    await staging.close();
  }
}

async function setup(t, approved, plan = 'pro') {
  const fixture = await require('../helpers/agent-workflow-fixture').fixture(t);
  const { db, ctx, owner } = fixture;
  const { recipient, grant } = approved;
  const connectorId = randomUUID();
  await fixture.subscribe(plan);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1", [owner.accountId]);
  if (plan !== 'starter') await autopilot.setMode(db, ctx, member, 'POLICY_AUTOMATED');
  await db.query("UPDATE suppliers SET email=$2 WHERE workspace_id=$1 AND id='fixture-supplier'", [ctx.workspaceId, recipient]);
  await db.query("UPDATE customers SET email=$2 WHERE workspace_id=$1 AND id='fixture-customer'", [ctx.workspaceId, recipient]);
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,
    config,status,capabilities,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
    VALUES($1,$2,$1,'Gmail fixture','gmail','[]','{"replyPreparationEnabled":true}','connected','["MAIL_SEND","MAIL_READ"]','CONNECTED',$3,$4,now(),now())`,
  [connectorId, ctx.workspaceId, ctx.actorId, recipient]);
  await db.transaction(client => store.put(client, ctx.workspaceId, connectorId, 'provider', grant));
  const sent = [];
  const provider = { send: async ({ credentials, message }) => {
    assert.ok(message.recipient.toLowerCase() === recipient, 'The fixture can only send to its own approved Gmail mailbox.');
    const subject = message.inReplyTo ? message.subject : '[StockChief test - no action] ' + message.subject;
    const result = await gmail.send({ credentials, message: { ...message, subject,
      body: 'StockChief synthetic workflow test. No order, shipment or reply is requested.\n\n' + message.body } });
    assert.ok(result.externalMessageId && result.externalThreadId);
    sent.push({ ...result, subject, originalBody: message.body });
    return result;
  } };
  const handlers = require('../../src/operations/postgres-runtime-handlers').create({ get: () => provider });
  const run = kind => queue.processOne(db, { [kind]: handlers[kind] }, { owner: 'gmail-provider-fixture', kinds: [kind] });
  const verify = async send => {
    const actual = await gmail.message(grant, send.externalMessageId);
    assert.equal(actual.subject, send.subject);
    assert.equal(actual.threadId, send.externalThreadId);
    assert.ok(actual.bodyText.replaceAll('\r\n','\n').includes(send.originalBody.replaceAll('\r\n','\n')));
  };
  const deliver = async (kind = 'mail.outbound.send') => {
    const pending = (await db.query(`SELECT id FROM stockchief_runtime.provider_effects
      WHERE workspace_id=$1 AND kind=$2 AND status='PENDING' ORDER BY created_at,id`, [ctx.workspaceId, kind])).rows;
    for (const row of pending) {
      const effect = await require('../../src/operations/postgres-provider-effects').get(db,ctx.workspaceId,row.id);
      const jobKind = require('../../src/operations/agent-mail-protocol').jobKind(effect);
      await handlers[jobKind]({workspaceId:ctx.workspaceId,kind:jobKind,payload:{effectId:row.id}},db);
      await verify(sent.at(-1));
    }
    return pending.length;
  };
  const today = await require('../../src/lib/business-time').today(db, ctx.workspaceId);
  const date = days => require('../../src/accounting/customer-money').addDays(today, days);
  const order = async ({ expectedDate = date(10), placed = false, quantity = 4, sku = fixture.item.skuIds[0] } = {}) => {
    const purchase = await workflows.createPurchaseOrder(db, ctx, { supplierId, destinationLocationId: fixture.location.id,
      orderDate: date(-5), expectedDate, idempotencyKey: randomUUID(), lines: [{ skuId: sku, quantityUnits: quantity, unitCost: 1 }] });
    await workflows.approvePurchaseOrder(db, ctx, purchase.purchaseOrderId, { idempotencyKey: randomUUID() });
    if (placed) await workflows.placePurchaseOrder(db, ctx, purchase.purchaseOrderId, { idempotencyKey: randomUUID() });
    return purchase;
  };
  const status = async orderId => (await db.query('SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId, orderId])).rows[0].status;
  const refresh = async purchase => {
    const work = (await db.query('SELECT id FROM work_items WHERE workspace_id=$1 AND idempotency_key=$2',
      [ctx.workspaceId, 'business-outcome:purchase:' + purchase.purchaseOrderId])).rows[0];
    await ownership.refresh(db, ctx.workspaceId, work.id);
    return work;
  };
  return { ...fixture, connectorId, recipient, provider, sent, verify, deliver, run, date, order, status, refresh };
}

test('Gmail accepts StockChief purchasing workflows using isolated records and a self-addressed test mailbox',
  { skip: !confirmedLogin || !process.env.STOCKCHIEF_GMAIL_FIXTURE_CONFIG, timeout: 300000 }, async t => {
    const approved = await verifiedGrant();
    await t.test('28. Starter approves the exact PO email, and Gmail returns the saved message', async t => {
      const f = await setup(t, approved, 'starter');
      const { db, ctx } = f;
      const purchase = await f.order();
      const assistant = require('../../src/assistant/postgres-service');
      const proposal = await assistant.createProposal(db, ctx, 'Email the approved synthetic PO', 'communication.send_email', {
        recipientKind: 'supplier', recipientId: supplierId, recipientEmail: f.recipient, connectorId: f.connectorId,
        purchaseOrderId: purchase.purchaseOrderId, subject: 'Purchase order ' + purchase.poNumber,
        body: 'Synthetic order for four test units.'
      }, 'Send the reviewed PO to the self-addressed test mailbox.');
      assert.equal(f.sent.length, 0);
      const sentProposal = await assistant.executeProposal(db, ctx, proposal.proposal.id);
      const delivery = await outbound.executeSendEffect(db, ctx.workspaceId, sentProposal.result.effectId, { provider: f.provider });
      assert.equal(delivery.message.status, 'SENT');
      assert.equal(delivery.message.external_message_id, f.sent[0].externalMessageId);
      await f.verify(f.sent[0]);
      assert.equal((await outbound.executeSendEffect(db, ctx.workspaceId, sentProposal.result.effectId, { provider: f.provider })).replayed, true);
      assert.equal(f.sent.length, 1);
    });
    await t.test('20. Growth, Pro and Custom place a reorder after Gmail acceptance, Starter blocks automatic buying', async t => {
      const f = await setup(t, approved, 'growth');
      const { db, ctx } = f;
      const sku = f.item.skuIds[0];
      const code = (await db.query('SELECT code FROM skus WHERE id=$1', [sku])).rows[0].code;
      await require('../../src/operations/postgres-commerce').linkSupplierItem(db, ctx, {
        supplierId, skuId: sku, lastUnitCost: 1, unitsPerPurchaseUnit: 1, minimumOrderQuantity: 1, orderMultiple: 1, isPreferred: true
      });
      await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,
        safety_stock,source,created_at,updated_at) VALUES($1,$2,$3,$4,5,10,0,'manual',now()::text,now()::text)`,
      [randomUUID(), ctx.workspaceId, sku, f.location.id]);
      await db.query(`UPDATE commercial_plan_versions SET configuration=jsonb_set(configuration,'{agentPurchaseLimits}',
        '{"currency":"USD","perOrder":500,"perWeek":2000}'::jsonb) WHERE plan_id='enterprise' AND status='ACTIVE'`);
      const plan = () => autopilot.plan(db, ctx.workspaceId, { onlySkuIds: [sku] });
      const rule = { purchaseEnabled: true, supplierIds: [supplierId], trustedItemCodes: code, maximumValue: 50, weeklyValue: 150 };
      await f.subscribe('starter');
      await assert.rejects(autopilot.configureRoutine(db, ctx, member, rule), error => error.code === 'entitlement_required');
      assert.ok((await plan()).created.every(item => item.approval_requirement !== 'NONE'));
      for (const [index, tier] of ['growth','pro','enterprise'].entries()) {
        await f.subscribe(tier);
        await autopilot.configureRoutine(db, ctx, member, rule);
        await autopilot.setCapability(db, ctx, member, 'supplier_emails', true);
        await db.query('UPDATE reorder_policies SET target_stock=$2 WHERE workspace_id=$1', [ctx.workspaceId, 10 + index]);
        const candidate = (await plan()).created.find(item => item.approval_requirement === 'NONE');
        assert.ok(candidate, tier + ' should authorize the repeat purchase');
        const work = await autopilot.execute(db, ctx, candidate.id);
        assert.equal(await f.status(work.purchase_order_id), 'APPROVED');
        assert.equal(await f.deliver(),1);
        assert.equal(await f.status(work.purchase_order_id), 'ORDERED');
        assert.equal((await outbound.executeSendEffect(db, ctx.workspaceId, work.outcome.effectId, { provider: f.provider })).replayed, true);
        await workflows.cancelPurchaseOrder(db, ctx, work.purchase_order_id, { reason: 'Synthetic fixture reset', idempotencyKey: randomUUID() });
      }
      assert.equal(f.sent.length, 3);
    });
    await t.test('29. Pro sends a confirmation request and saves the ship date from the emailed link', async t => {
      const f = await setup(t, approved);
      const { db, ctx } = f;
      const rule = { supplierId, expectedRecipient: f.recipient, connectorId: f.connectorId,
        maximumMessages: 2, intervalHours: 24, maximumShipDays: 5, confirmed: 'yes' };
      await confirmations.configure(db, ctx, rule);
      const purchase = await f.order({ placed: true });
      await db.query("UPDATE purchase_orders SET ordered_at=(now()-interval '3 days')::text WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, purchase.purchaseOrderId]);
      await f.refresh(purchase);
      const sent = await f.run('agent.mail.purchase_followup.v1');
      assert.equal(sent?.status, 'COMPLETED', JSON.stringify(sent?.lastError));
      assert.match(f.sent[0].originalBody, /planned ship date/);
      await f.verify(f.sent[0]);
      const token = /\/supplier\/order\/([A-Za-z0-9_-]{43})/.exec(f.sent[0].originalBody)[1];
      await links.submit(db, token, 'confirm', f.date(10), { shipDate: f.date(2) });
      assert.equal((await f.run(confirmations.kind)).result.shipDate, f.date(2));
      const saved = (await confirmations.recorded(db, ctx.workspaceId, purchase.purchaseOrderId))[0];
      assert.equal(saved.automatic, true);
      assert.equal((await db.query('SELECT expected_date::text AS date FROM purchase_orders WHERE id=$1',
        [purchase.purchaseOrderId])).rows[0].date, f.date(10));
    });
    await t.test('30. Growth sends one late-delivery chaser and records the Gmail receipt', async t => {
      const f = await setup(t, approved, 'growth');
      const { db, ctx } = f;
      await chases.configure(db, ctx, { supplierId, expectedRecipient: f.recipient, connectorId: f.connectorId,
        maximumMessages: 2, intervalHours: 24, confirmed: 'yes' });
      const purchase = await f.order({ placed: true, expectedDate: f.date(-2) });
      await Promise.all([f.refresh(purchase), f.refresh(purchase)]);
      const sent = await f.run('agent.mail.purchase_followup.v1');
      assert.equal(sent?.status, 'COMPLETED', JSON.stringify(sent?.lastError));
      assert.match(f.sent[0].originalBody, /4 ordered, 0 received/);
      await f.verify(f.sent[0]);
      await f.refresh(purchase);
      assert.equal(await f.run('agent.mail.purchase_followup.v1'), null);
      assert.equal(f.sent.length, 1);
    });
  });

test('Gmail accepts StockChief supplier forecasts, stock notices, quote follow-ups and customer replies',
  { skip: !confirmedLogin || !process.env.STOCKCHIEF_GMAIL_FIXTURE_CONFIG, timeout: 450000 }, async t => {
    const approved = await verifiedGrant();
    await t.test('36. Growth reviews a real forecast email and Pro sends the next one automatically', async t => {
      const f = await setup(t, approved, 'growth');
      const { db, ctx } = f;
      const sku = f.item.skuIds[0];
      const forecasts = require('../../src/purchasing/agent-supplier-forecasts');
      await require('../../src/operations/postgres-commerce').linkSupplierItem(db, ctx, {
        supplierId, skuId: sku, lastUnitCost: 1, unitsPerPurchaseUnit: 1, minimumOrderQuantity: 1, orderMultiple: 1, isPreferred: true
      });
      for (let day = 40; day >= 1; day -= 3) {
        const sale = await workflows.createSalesOrder(db, ctx, { customerId: 'fixture-customer', deliveryMethod: 'PICKUP',
          fulfillmentLocationId: f.location.id, orderDate: f.date(-day), idempotencyKey: randomUUID(),
          lines: [{ skuId: sku, quantity: 1, unitPriceMinor: 1200 }] });
        await workflows.confirmSalesOrder(db, ctx, sale.salesOrderId, { idempotencyKey: randomUUID() });
      }
      await forecasts.addKey(db, ctx, { supplierId });
      assert.equal((await forecasts.run(db, ctx.workspaceId)).waiting, 1);
      const pending = (await db.query('SELECT id,source_fingerprint,snapshot FROM stockchief_runtime.agent_supplier_forecast_reports WHERE workspace_id=$1',
        [ctx.workspaceId])).rows[0];
      assert.equal(pending.snapshot.rows[0].weeks.length, 12);
      assert.equal(await f.deliver(), 0);
      await forecasts.send(db, ctx, pending.id, { fingerprint: pending.source_fingerprint });
      assert.equal(await f.deliver(), 1);
      assert.match(f.sent[0].originalBody, /Week 12 \(/);
      await f.subscribe('pro');
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 7 * 86400000 });
      assert.equal((await forecasts.run(db, ctx.workspaceId)).queued, 1);
      assert.equal(await f.deliver(), 1);
      assert.equal((await forecasts.run(db, ctx.workspaceId)).queued, 0);
    });
    await t.test('50. Pro sends an exact stock-ready notice after actual allocation and does not duplicate it', async t => {
      const f = await setup(t, approved);
      const { db, ctx } = f;
      const ready = require('../../src/sales/agent-stock-ready');
      const shipped=await f.parcel({ quantity: 1 });
      await f.shipping.markPacked(db,ctx,shipped.shipmentId);
      await f.shipping.handoff(db,ctx,shipped.shipmentId,{handover:'CARRIER',trackingNumber:randomUUID(),carrier:'UPS'});
      await ready.configure(db, ctx, { revision: 0, connectorId: f.connectorId });
      const sku = f.item.skuIds[0];
      const available = (await require('../../src/transfers/postgres-transfer-service').sourceAvailable(db,ctx.workspaceId,sku,f.location.id)).available;
      const sale = await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'SHIP',
        shipToAddress:'10 Jobsite Rd, Albany, NY 12207',fulfillmentLocationId:f.location.id,idempotencyKey:randomUUID(),
        lines:[{skuId:sku,quantity:available+1,unitPriceMinor:1200}]});
      await workflows.confirmSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID()});
      assert.equal((await ready.run(db,ctx.workspaceId)).queued,0);
      await require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId:sku,locationId:f.location.id,
        quantity:1,unitCost:'1.00',idempotencyKey:randomUUID()});
      await workflows.confirmSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID()});
      assert.equal((await ready.run(db,ctx.workspaceId)).queued,1);
      assert.equal(await f.deliver(),1);
      assert.match(f.sent[0].subject,/Stock reserved/);
      assert.equal((await ready.run(db,ctx.workspaceId)).queued,0);
    });
    await t.test('74. Pro sends a due follow-up for a quote that Gmail actually accepted', async t => {
      const f = await setup(t, approved);
      const { db, ctx } = f;
      const quotes = require('../../src/sales/postgres-quotes');
      const followups = require('../../src/sales/agent-quote-followups');
      const requests = require('../../src/sales/agent-quote-requests');
      const quotationMail = require('../../src/sales/quotation-mail');
      const sku = f.item.skuIds[0];
      await db.transaction(c=>require('../../src/pricing/postgres-service').setPricesInTransaction(c,ctx,[{skuId:sku,amountMinor:1200,currency:'USD'}]));
      await requests.saveSettings(db,ctx,{days:'2',revision:0},'followup_days');
      const quote=await quotes.create(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',currency:'USD',
        orderDate:f.date(0),discountMinor:0,taxMinor:0,codes:[],lines:[{skuId:sku,quantity:2}],validUntil:f.date(14),requestKey:randomUUID()});
      const facts=await quotationMail.facts(db,ctx,quote.id,f.connectorId);
      await quotationMail.send(db,ctx,quote.id,{connectorId:f.connectorId,expectedFingerprint:facts.sourceFingerprint,confirmed:'yes'});
      assert.equal(await f.deliver(),1);
      assert.equal((await followups.run(db,ctx.workspaceId)).queued,0);
      t.mock.timers.enable({apis:['Date'],now:Date.now()+3*86400000});
      assert.equal((await followups.run(db,ctx.workspaceId)).queued,1);
      assert.equal(await f.deliver(),1);
      assert.match(f.sent[1].originalBody,/which we emailed on/);
      assert.equal((await followups.run(db,ctx.workspaceId)).queued,0);
    });
    await t.test('89. A reviewed supplier question sends from the authorized mailbox and records its receipt', async t => {
      const f = await setup(t, approved, 'growth');
      const { db, ctx } = f;
      const assistant = require('../../src/assistant/postgres-service');
      const proposal = await assistant.createProposal(db,ctx,'Email the supplier','communication.send_email',{
        recipientKind:'supplier',recipientId:supplierId,recipientEmail:f.recipient,connectorId:f.connectorId,
        subject:'Supplier reference question',body:'Could you confirm the catalogue reference for the synthetic test item?'
      },'Send the reviewed question to the supplier fixture.');
      assert.equal(await f.deliver(),0);
      await assistant.executeProposal(db,ctx,proposal.proposal.id);
      assert.equal(await f.deliver(),1);
      assert.match(f.sent[0].originalBody,/catalogue reference/);
    });
    await t.test('72 and 187. StockChief reads Gmail and sends each approved reply into its original Gmail thread', async t => {
      const f = await setup(t, approved);
      const { db, ctx } = f;
      await db.query("UPDATE suppliers SET email=NULL WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
      const connection = (await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[f.connectorId])).rows[0];
      const mail = require('../../src/connections/postgres-mail');
      const parcel = await f.parcel({ quantity: 2 });
      const sendAndCapture = async (subject, body) => {
        const seed = await gmail.send({credentials:approved.grant,message:{recipient:f.recipient,
          subject:'[StockChief test - no action] '+subject+' '+randomUUID().replace(/\d/g,'x').slice(0,8),body}});
        const original = await gmail.message(approved.grant,seed.externalMessageId);
        const capture = await mail.capture(db,connection,original);
        assert.ok(capture.accepted);
        return { ...seed, ...capture, subject:original.subject };
      };
      const order = await sendAndCapture('Order status','Hi, where is my order '+parcel.order.orderNumber+'? Thanks, Rita');
      assert.equal((await f.run('mail.customer-question.v1')).result.queued,true);
      assert.equal(await f.deliver(),1);
      assert.equal(f.sent[0].externalThreadId,order.externalThreadId);
      assert.match(f.sent[0].originalBody,/2 ordered, 0 shipped/);
      const general = await sendAndCapture('Opening hours','Hi, could you remind me of your warehouse opening hours? Thanks, Rita');
      const drafting = require('../../src/connections/postgres-reply-drafting');
      const model=require('../../src/ai/provider').createProviderUnobserved('anthropic',require('../../src/config').ai.tier('fast'));
      await db.query(`INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason)
        VALUES($1,$2,'ai_work_credits',1000,'Synthetic mailbox draft test')`,[randomUUID(),f.owner.accountId]);
      const provider={...model,async complete(input){
        assert.equal(input.schemaName,'prepared_reply');
        assert.match(input.prompt,/warehouse opening hours/);
        assert.ok(input.prompt.includes('The sender is customer Receiver.'));
        assert.ok(!input.prompt.includes(f.recipient),'The live mailbox address stays out of the model prompt.');
        const result=await model.complete(input);
        return {...result,data:{...result.data,subject:'Re: '+general.subject}};
      }};
      // The source text is synthetic. Omit the live mailbox address from the
      // single model request while keeping the original sender for delivery.
      await drafting.prepare(db,ctx,general.messageId,{provider:{...provider,complete:input=>provider.complete({
        ...input,prompt:input.prompt.replaceAll(f.recipient,'customer@example.test')
      })}});
      assert.equal((await f.run('mail.agent-reply.v1')).result.queued,true);
      assert.equal(await f.deliver('mail.reply.send'),1);
      assert.equal(f.sent[1].externalThreadId,general.externalThreadId);
      assert.equal(await f.deliver('mail.reply.send'),0);
    });
  });
