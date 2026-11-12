'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const assistant=require('../../src/assistant/postgres-service');
test('kit planning checks available components, packs, current tiers, stale stock and duplicate drafts',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:5}),{db,ctx,subscribe,workflows}=f;
  await subscribe('growth');await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  const catalog=require('../../src/domain/postgres-catalog-service'),kit=await catalog.createItem(db,ctx,{name:'Two component kit',baseCode:'PLANNED-KIT',trackingMode:'quantity'});
  const part=await catalog.createItem(db,ctx,{name:'Other component',baseCode:'KIT-PART',trackingMode:'quantity'}),sku=f.item.skuIds[0];
  await require('../../src/domain/postgres-kit-service').define(db,ctx,{kitSkuId:kit.skuIds[0],components:[{skuId:sku,quantity:2},{skuId:part.skuIds[0],quantity:1}]});
  await require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId:part.skuIds[0],locationId:f.location.id,quantity:1,unitCost:1,idempotencyKey:randomUUID()});
  const commerce=require('../../src/operations/postgres-commerce');
  await commerce.linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId:sku,unitsPerPurchaseUnit:1,lastUnitCost:1,isPreferred:true});
  await commerce.linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId:part.skuIds[0],purchaseUnit:'case',unitsPerPurchaseUnit:3,lastUnitCost:2,isPreferred:true});
  const args={action:'kit.replenish_parts',sku:'PLANNED-KIT',quantity:4,location:'Dispatch'},prepare=()=>assistant.prepareAction(db,ctx,'Replenish parts for four kits',args);
  await subscribe('starter');const suggestion=await require('../../src/autopilot/job-reviews').run(db,ctx,'kit-capacity');
  assert.equal(suggestion.rows.length,1);assert.match(suggestion.rows[0].Suggestion,/^Build 1 PLANNED-KIT at Dispatch now\. Limited by KIT-PART: 1 available, 1 per kit\.$/);await assert.rejects(prepare(),e=>e.code==='entitlement_required');
  for(const tier of ['growth','pro','enterprise']){await subscribe(tier);const review=await require('../../src/autopilot/job-reviews').run(db,ctx,'kit-capacity');assert.equal(review.rows[0]['Build now'],1);assert.equal((await prepare()).status,'PREPARED');}
  await subscribe('growth');const p=await prepare();
  await subscribe('starter');await assert.rejects(assistant.executeProposal(db,ctx,p.proposal.id),e=>e.code==='entitlement_required');
  await subscribe('growth');await require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId:sku,locationId:f.location.id,quantity:1,unitCost:1,idempotencyKey:randomUUID()});
  await assert.rejects(assistant.executeProposal(db,ctx,p.proposal.id),/changed/);
  const fresh=await prepare();await assistant.executeProposal(db,ctx,fresh.proposal.id);await assistant.executeProposal(db,ctx,fresh.proposal.id);
  const lines=(await db.query("SELECT l.sku_id,l.quantity_units,l.units_per_purchase_unit FROM purchase_order_lines l JOIN purchase_orders o ON o.workspace_id=l.workspace_id AND o.id=l.purchase_order_id WHERE o.workspace_id=$1 AND o.status='DRAFT'",[ctx.workspaceId])).rows;
  assert.equal(lines.length,2);assert.equal(Number(lines.find(l=>l.sku_id===sku).quantity_units),2);assert.equal(Number(lines.find(l=>l.sku_id===part.skuIds[0]).quantity_units),3);
  await assert.rejects(prepare(),/already cover/);assert.equal(await f.balance(),7);
});
