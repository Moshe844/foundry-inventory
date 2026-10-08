'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const {pricedUsage,PRICED_MODEL}=require('../helpers/postgres-model-fixture');
const catalog=require('../../src/domain/postgres-catalog-service');
const locations=require('../../src/domain/postgres-location-service');
const inventory=require('../../src/domain/postgres-inventory-engine');
const pricing=require('../../src/pricing/postgres-service');
const stockAlerts=require('../../src/manager/postgres-stock-threshold-alerts');
const instructions=require('../../src/manager/postgres-operating-instructions');
const workflows=require('../../src/operations/postgres-business-workflows');
const {registry}=require('../../src/assistant/postgres-capability-registry');
const resolver=require('../../src/assistant/postgres-context-resolver');

const token=(html)=>/name="_csrf" value="([^"]+)"/.exec(html)?.[1];
const step=(capability,args={})=>({capability,arguments:Object.entries(args).map(([name,value])=>
  ({name,value:String(value)})),dependsOn:[],continuesPending:false});
const change=(values={})=>({domain:'stock_alert',operation:'set',sku:'',supplier:'',location:'',sourceLocation:'',
  reorderPoint:-1,targetStock:-1,safetyStock:-1,leadTimeDays:-1,unitsPerPurchaseUnit:-1,
  minimumOrderQuantity:-1,orderMultiple:-1,maximumQuantity:-1,maximumValue:-1,weeklyValue:-1,
  daysOfStock:-1,preferTransferBeforePurchasing:false,guardMode:'',guardComparator:'',
  guardThreshold:-1,guardReleaseCondition:'',notificationThreshold:-1,
  notificationMetric:'on_hand',notificationComparator:'at_or_below',...values});

test('Ask approvals update the conversation, invoices use the canonical ledger, and stock alerts really fire',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'ask-owner-journeys'});
    await migratePostgres(database);
    const selected=[
      step('contact.create',{recipient:'River Market',recipientKind:'customer',recipientEmail:'river@example.test',phone:'555-0188'}),
      step('customer_invoice.create',{customer:'River Market',sku:'Blue Shoe',quantity:3}),
      step('policy.propose'),
    ];
    const provider={name:'anthropic',model:PRICED_MODEL,async complete(input){
      if(input.schemaName==='stockchief_capability_plan')return {data:{steps:[selected.shift()],
        clarifyingQuestion:''},usage:pricedUsage()};
      if(input.schemaName==='stockchief_capability_fit')return {data:{aligned:true,reason:''},usage:pricedUsage()};
      if(input.schemaName==='postgres_operating_instruction')return {data:{understood:true,
        summary:'Alert when Blue Shoe reaches four on hand',clarifyingQuestion:'',unsupportedReason:'',
        changes:[change({sku:'Blue Shoe',notificationThreshold:4})]},usage:pricedUsage()};
      if(input.schemaName==='postgres_operating_instruction_effect_fit')return {
        data:{equivalent:true,difference:''},usage:pricedUsage()};
      throw new Error(`Unexpected schema ${input.schemaName}`);
    }};
    const app=createPostgresApp({database,env:'test',sessionSecret:'ask-owner-journeys-secret',aiProvider:provider});
    context.after(async()=>{await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const agent=request.agent(app);
    const registration=await agent.get('/register');
    await agent.post('/register').type('form').send({_csrf:token(registration.text),name:'Owner',
      businessName:'Owner Journeys',email:'owner-journeys@example.test',password:'owner-journeys-password'});
    const owner=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id WHERE w.name='Owner Journeys'`)).rows[0];
    const ctx={workspaceId:owner.workspace_id,actorId:owner.actor_id};
    const place=await locations.createLocation(database,ctx,{name:'Main Room',kind:'warehouse'});
    const product=await catalog.createItem(database,ctx,{name:'Blue Shoe',baseCode:'BLUE-SHOE',trackingMode:'quantity'});
    await pricing.setPrice(database,ctx,{skuId:product.skuIds[0],amountMinor:2500,currency:'USD'});
    await inventory.receive(database,ctx,{skuId:product.skuIds[0],locationId:place.id,quantity:8,
      reference:'OPENING',idempotencyKey:'ask-owner-opening'});
    const recovered=await resolver.resolveArguments(database,ctx,registry.get('inventory.receive'),
      {sku:'BX-27',location:'Main Room',quantity:'5',reference:'BX-27'},
      {message:'Five Blue Shoes arrived into Main Room with delivery reference BX-27.'});
    assert.equal(recovered.args.sku,'BLUE-SHOE');
    assert.equal(recovered.provenance.sku.source,'verified_in_owner_message');
    await locations.createLocation(database,ctx,{name:'Side Room',kind:'warehouse'});
    const omitted=await resolver.resolveArguments(database,ctx,registry.get('inventory.receive'),
      {sku:'Blue Shoe',quantity:'2'},
      {message:'Two Blue Shoes arrived at Main Room.'});
    assert.equal(omitted.args.location,'Main Room');
    assert.equal(omitted.provenance.location.source,'verified_in_owner_message');
    const unstocked=await catalog.createItem(database,ctx,{name:'Dry Canvas',baseCode:'DRY-CANVAS',
      trackingMode:'quantity'});
    const named=await resolver.resolveArguments(database,ctx,registry.get('purchase_order.create'),
      {sku:'Dry Canvas',skuScope:'currently_stocked',quantity:'2'},
      {message:'Prepare a purchase order for two Dry Canvas rolls.'});
    assert.equal(named.args.sku,'DRY-CANVAS');
    assert.equal(unstocked.skuIds.length,1);
    const ask=async(message)=>{const page=await agent.get('/ask');
      const response=await agent.post('/ask').type('form').send({_csrf:token(page.text),message});
      assert.equal(response.status,303);return (await agent.get('/ask')).text;};
    let html=await ask('Put River Market in our customers with river@example.test and phone 555-0188.');
    assert.match(html,/Needs your approval/);
    assert.match(html,/555-0188/);
    let proposal=(await database.query(`SELECT id FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1`,[ctx.workspaceId])).rows[0];
    let review=await agent.get(`/actions/${proposal.id}`);
    assert.equal((await agent.post(`/actions/${proposal.id}/approve`).type('form')
      .send({_csrf:token(review.text)})).status,303);
    html=(await agent.get('/ask')).text;
    assert.match(html,/Completed: Add River Market as a customer/);
    assert.doesNotMatch(html,/Needs your approval/);
    html=await ask('Bill River Market for three Blue Shoes.');
    assert.match(html,/Completed: Add River Market as a customer/);
    proposal=(await database.query(`SELECT id,action_type,payload FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,[ctx.workspaceId])).rows[0];
    assert.equal(proposal.action_type,'customer_invoice.create');
    assert.equal((await database.query(`SELECT COUNT(*)::int AS n FROM accounting_customer_invoices
      WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0].n,0);
    review=await agent.get(`/actions/${proposal.id}`);
    assert.equal((await agent.post(`/actions/${proposal.id}/approve`).type('form')
      .send({_csrf:token(review.text)})).status,303);
    const invoice=(await database.query(`SELECT i.status,i.total_minor,i.journal_entry_id,c.name
      FROM accounting_customer_invoices i JOIN customers c ON c.id=i.customer_id
      WHERE i.workspace_id=$1`,[ctx.workspaceId])).rows[0];
    assert.equal(invoice.name,'River Market');assert.equal(invoice.status,'OPEN');
    assert.equal(Number(invoice.total_minor),7500);assert.ok(invoice.journal_entry_id);
    html=(await agent.get('/ask')).text;assert.match(html,/Completed: Record an invoice/);
    html=await ask('Let me know when Blue Shoe gets to four on hand.');
    assert.match(html,/Review prepared change/);
    const rule=(await database.query(`SELECT id,integrity_hash FROM operating_instruction_proposals
      WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1`,[ctx.workspaceId])).rows[0];
    review=await agent.get(`/operating-instructions/${rule.id}`);
    assert.match(review.text,/at or below 4 physically on hand/);
    assert.equal((await agent.post(`/operating-instructions/${rule.id}/approve`).type('form')
      .send({_csrf:token(review.text),integrityHash:rule.integrity_hash})).status,303);
    html=(await agent.get('/ask')).text;assert.match(html,/Rule in force:/);
    assert.doesNotMatch(html,/Needs your approval/);
    const stored=(await database.query(`SELECT id,threshold,armed FROM stockchief_runtime.stock_threshold_rules
      WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0];
    assert.equal(Number(stored.threshold),4);assert.equal(stored.armed,true);
    await inventory.issue(database,ctx,{skuId:product.skuIds[0],locationId:place.id,quantity:4,
      reasonCode:'other',reference:'ORDER-1',idempotencyKey:'ask-owner-issue'});
    assert.deepEqual(await stockAlerts.evaluate(database,{workspaceId:ctx.workspaceId}),
      {checked:1,alerted:1,rearmed:0});
    assert.deepEqual(await stockAlerts.evaluate(database,{workspaceId:ctx.workspaceId}),
      {checked:1,alerted:0,rearmed:0});
    const alert=(await database.query(`SELECT status,title FROM attention_items WHERE workspace_id=$1
      AND fingerprint=$2`,[ctx.workspaceId,`stock-threshold:${stored.id}`])).rows[0];
    assert.equal(alert.status,'OPEN');assert.match(alert.title,/reached 4 on hand/);
    const ownerAttention=await agent.get('/needs-you');
    assert.equal(ownerAttention.status,200);
    assert.match(ownerAttention.text,/Blue Shoe/);
    await inventory.receive(database,ctx,{skuId:product.skuIds[0],locationId:place.id,quantity:1,
      reference:'RESTOCK',idempotencyKey:'ask-owner-restock'});
    assert.deepEqual(await stockAlerts.evaluate(database,{workspaceId:ctx.workspaceId}),
      {checked:1,alerted:0,rearmed:1});
    assert.equal((await database.query(`SELECT status FROM attention_items WHERE workspace_id=$1
      AND fingerprint=$2`,[ctx.workspaceId,`stock-threshold:${stored.id}`])).rows[0].status,'RESOLVED');
    await inventory.issue(database,ctx,{skuId:product.skuIds[0],locationId:place.id,quantity:1,
      reasonCode:'other',reference:'ORDER-2',idempotencyKey:'ask-owner-issue-again'});
    assert.deepEqual(await stockAlerts.evaluate(database,{workspaceId:ctx.workspaceId}),
      {checked:1,alerted:1,rearmed:0});
    assert.equal((await database.query(`SELECT status FROM attention_items WHERE workspace_id=$1
      AND fingerprint=$2`,[ctx.workspaceId,`stock-threshold:${stored.id}`])).rows[0].status,'OPEN');
    // An available-to-fulfill warning must react to an allocation without a
    // physical stock movement; "below" must not fire at the equal boundary.
    const availableInstruction='Warn when Blue Shoe available to fulfill drops below 4; do not buy anything.';
    const proposalCount=Number((await database.query(`SELECT COUNT(*) AS n FROM operating_instruction_proposals
      WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0].n);
    const forMeasure=(metric,equivalent)=>({name:'anthropic',model:PRICED_MODEL,
      async complete(input){if(input.schemaName==='postgres_operating_instruction')return {
        data:{understood:true,summary:'A stock alert',clarifyingQuestion:'',unsupportedReason:'',
          changes:[change({sku:'Blue Shoe',notificationThreshold:4,notificationMetric:metric,
            notificationComparator:'below'})]},usage:pricedUsage()};
        if(input.schemaName==='postgres_operating_instruction_effect_fit'){
          const evidence=JSON.parse(input.prompt);
          assert.deepEqual([evidence.resolvedEntities[0].requestedSku,
            evidence.resolvedEntities[0].verifiedSkuCode,
            evidence.resolvedEntities[0].verifiedProductName],['Blue Shoe','BLUE-SHOE','Blue Shoe']);
          return {data:{equivalent,difference:equivalent?'':
            'Available-to-fulfill was changed to physical on-hand.'},usage:pricedUsage()};
        }
        throw new Error(`Unexpected schema ${input.schemaName}`);}});
    await assert.rejects(instructions.interpret(database,ctx,availableInstruction,
      {provider:forMeasure('on_hand',false),instructionUsageKey:'mismatched-alert'}),
    /won't propose a rule that changes your request/);
    assert.equal(Number((await database.query(`SELECT COUNT(*) AS n FROM operating_instruction_proposals
      WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0].n),proposalCount);
    const availableProposal=await instructions.interpret(database,ctx,availableInstruction,
      {provider:forMeasure('available_to_fulfill',true),instructionUsageKey:'exact-available-alert'});
    assert.match(availableProposal.summary,/below 4 available to fulfill after customer commitments/);
    await instructions.approve(database,ctx,availableProposal.id,availableProposal.integrityHash);
    const revised=(await database.query(`SELECT metric,comparator,threshold FROM stockchief_runtime.stock_threshold_rules
      WHERE id=$1`,[stored.id])).rows[0];
    assert.deepEqual([revised.metric,revised.comparator,Number(revised.threshold)],
      ['available_to_fulfill','below',4]);
    const ruleRead=await require('../../src/assistant/postgres-service').lookup(database,ctx,
      {view:'operating_rules',search:'BLUE-SHOE'});
    assert.equal(ruleRead.rows.find((row)=>row.kind==='stock_warning').threshold,4);
    assert.equal(ruleRead.rows.find((row)=>row.kind==='stock_warning').metric,'available_to_fulfill');
    assert.match(ruleRead.answer,/strictly below 4 available to fulfill; it does not email or purchase/);
    assert.deepEqual(await stockAlerts.evaluate(database,{workspaceId:ctx.workspaceId}),
      {checked:1,alerted:0,rearmed:0});
    const customer=(await database.query(`SELECT id FROM customers WHERE workspace_id=$1 AND name='River Market'`,
      [ctx.workspaceId])).rows[0];
    const order=await workflows.createSalesOrder(database,ctx,{customerId:customer.id,deliveryMethod:'PICKUP',
      lines:[{skuId:product.skuIds[0],quantity:1,unitPriceMinor:2500}],idempotencyKey:'alert-availability-order'});
    await workflows.confirmSalesOrder(database,ctx,order.salesOrderId,
      {requireFullAllocation:true,idempotencyKey:'alert-availability-confirm'});
    assert.deepEqual(await stockAlerts.evaluate(database,{workspaceId:ctx.workspaceId}),
      {checked:1,alerted:1,rearmed:0});
    const availableAlert=(await database.query(`SELECT title,metrics FROM attention_items WHERE workspace_id=$1
      AND fingerprint=$2`,[ctx.workspaceId,`stock-threshold:${stored.id}`])).rows[0];
    assert.match(availableAlert.title,/reached 3 available to fulfill/);
    assert.equal(JSON.parse(availableAlert.metrics).metric,'available_to_fulfill');
    assert.equal(Number((await database.query(`SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2`,
      [ctx.workspaceId,product.skuIds[0]])).rows[0].on_hand),4);
    await workflows.cancelSalesOrder(database,ctx,order.salesOrderId,
      {reason:'Synthetic threshold test',idempotencyKey:'alert-availability-cancel'});
    assert.deepEqual(await stockAlerts.evaluate(database,{workspaceId:ctx.workspaceId}),
      {checked:1,alerted:0,rearmed:1});
  });
