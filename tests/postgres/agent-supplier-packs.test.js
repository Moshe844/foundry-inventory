'use strict';
process.env.NODE_ENV='test';
process.env.FOUNDRY_PUBLIC_URL='https://fixture.example.test';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const autonomy=require('../../src/autopilot/postgres-service');
const terms=require('../../src/purchasing/agent-order-quantities');
const reviews=require('../../src/autopilot/job-reviews');

test('supplier terms round a real order to cases and add goods only within the freight saving or supplier minimum',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:4});
  const {db,ctx,subscribe,browser}=f,sku=f.item.skuIds[0],vendor='fixture-supplier';
  await subscribe('pro');
  await db.query("UPDATE accounts SET created_at=(now()-interval '16 days')::text WHERE id=$1",[f.owner.accountId]);
  await db.query("UPDATE suppliers SET email='orders@example.test' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,vendor]);
  await require('../../src/operations/postgres-commerce').linkSupplierItem(db,ctx,{supplierId:vendor,skuId:sku,lastUnitCost:1,
    unitsPerPurchaseUnit:3,orderMultiple:2,minimumOrderQuantity:1,isPreferred:true});
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,created_at,updated_at)
    VALUES($1,$2,$1,'Test mailbox','gmail','[]','{}','connected','[]',now()::text,now()::text)`,[randomUUID(),ctx.workspaceId]);
  await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,source,created_at,updated_at)
    VALUES($1,$2,$3,$4,5,11,0,'manual',now()::text,now()::text)`,[randomUUID(),ctx.workspaceId,sku,f.location.id]);
  const input={supplierId:vendor,currency:'USD',threshold:'18',freight:'7',mode:'save'};
  const plan=()=>autonomy.plan(db,ctx.workspaceId);
  const href='/purchasing/freight/'+vendor;
  const form=await browser.get(href).expect(200);
  await browser.post(href).type('form').send({...input,_csrf:f.csrf(form.text)}).expect(303);
  const initial=await plan(),held=initial.created.find(r=>r.recommendedAction.skuId===sku);
  assert.equal(held.recommendedAction.quantity,18);assert.equal(held.recommendedAction.purchaseUnits,6);
  assert.ok(held.sourceEvidence.some(e=>e.value==='Free shipping'));
  await subscribe('starter');
  await assert.rejects(terms.saveFreight(db,ctx,input),e=>e.code==='entitlement_required');
  await assert.rejects(reviews.run(db,ctx,'supplier-packs'),e=>e.code==='entitlement_required');
  assert.match((await reviews.run(db,ctx,'supplier-minimums')).rows[0].Suggestion,/Fixture parts/);
  assert.match((await plan()).considered.find(r=>r.skuId===sku).reason,/Growth/);
  await assert.rejects(autonomy.approve(db,ctx,{role:'owner'},held.id),/Growth/);
  for(const tier of ['growth','pro','enterprise']){
    await subscribe(tier);
    assert.equal(Number((await reviews.run(db,ctx,'supplier-packs')).rows[0]['Units per pack']),3);
    assert.equal((await reviews.run(db,ctx,'supplier-minimums')).rows[0]['Free shipping threshold'],'$18.00');
    assert.equal((await plan()).considered.find(r=>r.skuId===sku).quantity,18);
  }
  await terms.saveFreight(db,ctx,{...input,freight:'5'});
  const smaller=(await plan()).considered.find(r=>r.skuId===sku);
  assert.equal(smaller.quantity,12);
  await assert.rejects(autonomy.approve(db,ctx,{role:'owner'},held.id),/terms, price or the required quantity changed/);
  await db.query('UPDATE suppliers SET minimum_order_amount=16 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,vendor]);
  const bigger=await plan(),min=bigger.created.find(r=>r.recommendedAction.skuId===sku);
  assert.ok(min.sourceEvidence.some(e=>e.value==='Minimum order value'));
  const executed=await autonomy.approve(db,ctx,{role:'owner'},min.id);
  const {rows:[line]}=await db.query('SELECT * FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2',[ctx.workspaceId,executed.purchase_order_id]);
  assert.equal(Number(line.quantity_units),18);assert.equal(Number(line.quantity_purchase_units),6);assert.equal(Number(line.units_per_purchase_unit),3);
});
