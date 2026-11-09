'use strict';

process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const reviews=require('../../src/autopilot/job-reviews');

test('plain-language brand watches follow new SKUs, fractional stock, recovery and the shared Starter rule cap',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,subscribe,browser}=f;
  const module=require('../../src/autopilot/brand-watches'),notices=require('../../src/autopilot/operational-notices');
  const catalog=require('../../src/domain/postgres-catalog-service'),inventory=require('../../src/domain/postgres-inventory-engine');
  const uid=require('node:crypto').randomUUID,worker=require('../../src/operations/postgres-runtime-handlers').autopilotEvaluate;
  await subscribe('starter');
  const add=async(code,brand)=>{
    const product=await catalog.createItem(db,ctx,{name:'Measured '+code,baseCode:code,trackingMode:'quantity',unitLabel:'kg',quantityPrecision:2,quantityIncrement:'0.01'});
    await db.query('INSERT INTO catalogue_item_facts(workspace_id,item_id,facts,created_at,updated_at) VALUES($1,$2,$3,now(),now())',[ctx.workspaceId,product.itemId,JSON.stringify({brand})]);
    return product.skuIds[0];
  };
  const first=await add('WATCH-A','Nike'),receive=(skuId,quantity)=>inventory.receive(db,ctx,{skuId,quantity,locationId:f.location.id,idempotencyKey:uid()});
  await receive(first,'19.75');
  const root='/autopilot/reviews/brand-watches',page=await browser.get(root).expect(200);
  await browser.post(root+'/rules').type('form').send({_csrf:f.csrf(page.text),instruction:'Tell me if any Nike item drops under 20'}).expect(303);
  const read=()=>reviews.run(db,ctx,'brand-watches',{scheduled:true});
  const seen=()=>db.query("SELECT reference,resolved,reminders FROM stockchief_runtime.agent_operational_notices WHERE workspace_id=$1 AND job_id=167 ORDER BY reference",[ctx.workspaceId]);
  const evaluate=()=>db.transaction(c=>worker({id:uid(),workspaceId:ctx.workspaceId,payload:{actorId:ctx.actorId,requestedByUser:true}},c));
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);const result=await read();
    assert.deepEqual(result.rows.map(r=>[r.SKU,Number(r['On hand'])]),[['WATCH-A',19.75]]);
    assert.match((await browser.get('/needs-you').expect(200)).text,/Stock below a brand watch level/);
  }
  await receive(first,'0.25');
  await add('WATCH-B','NIKE');await add('WATCH-C','Other');
  await evaluate();await notices.refresh(db,ctx.workspaceId);
  assert.deepEqual((await read()).rows.map(r=>r.SKU),['WATCH-B']);
  assert.deepEqual((await seen()).rows.map(r=>[r.reference,r.resolved,r.reminders]),[['WATCH-A',true,1],['WATCH-B',false,1]]);
  await module.save(db,ctx,{instruction:'Notify me when any Nike item is at or below 20'});
  assert.equal((await seen()).rows[0].reminders,2);
  await assert.rejects(module.save(db,{...ctx,actorId:'missing'},{remove:'Nike'}),/owner/);
  await assert.rejects(module.save(db,ctx,{instruction:'Tell me if any Unrecorded item drops under 5'}),/No active product/);
  await subscribe('starter');
  for(let i=0;i<4;i++){await add('FILL-'+i,'Brand '+i);await module.save(db,ctx,{instruction:'Tell me if any Brand '+i+' item drops under 1'});}
  await assert.rejects(module.save(db,ctx,{instruction:'Tell me if any Other item drops under 1'}),/5 active rules/);
  await module.save(db,ctx,{remove:'Nike'});
  await module.save(db,ctx,{instruction:'Tell me if any Other item drops under 1'});
  assert.equal((await seen()).rows.filter(r=>r.reference.startsWith('WATCH-')&&!r.resolved).length,1);
  const native=require('../../src/manager/postgres-stock-threshold-alerts');
  await db.query(`INSERT INTO stockchief_runtime.stock_threshold_rules(id,workspace_id,sku_id,threshold,comparator,metric,stated_as,approved_by_user_id)
    VALUES('fraction-test',$1,$2,21,'below','on_hand','Below 21 kg',$3)`,[ctx.workspaceId,first,ctx.actorId]);
  await receive(first,'0.75');await native.evaluate(db,{workspaceId:ctx.workspaceId});
  const receipt=(await db.query("SELECT last_evaluation FROM stockchief_runtime.stock_threshold_rules WHERE id='fraction-test'")).rows[0].last_evaluation;
  assert.equal(receipt.observed,20.75);assert.equal(receipt.conditionMet,true);
});

test('day-one health scores active product records and exposes exact fixes at each plan level',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t);
  const {db,ctx,subscribe,browser}=f,catalog=require('../../src/domain/postgres-catalog-service');
  await subscribe('enterprise');
  const complete=await catalog.createItem(db,ctx,{name:'Complete set',baseCode:'HEALTH-1',trackingMode:'quantity',purchaseCost:'0',weightGrams:120});
  const other=await catalog.createItem(db,ctx,{name:'Duplicate scan',baseCode:'HEALTH-2',trackingMode:'quantity'});
  await db.query("UPDATE skus SET barcode='000031' WHERE workspace_id=$1 AND id=ANY($2::text[])",[ctx.workspaceId,[complete.skuIds[0],other.skuIds[0]]]);
  await db.query(`INSERT INTO catalogue_item_facts(workspace_id,item_id,category,facts,created_at,updated_at)
    VALUES($1,$2,'Packaging','{"brand":"Sample"}',now(),now()),($1,$3,'Packaging','{"brand":"Sample"}',now(),now()),
      ($1,$4,NULL,'{"brand":"Sample","material":"Paper"}',now(),now())`,[ctx.workspaceId,f.item.itemId,complete.itemId,other.itemId]);
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    const home=await browser.get('/onboarding?add=1').expect(200);
    assert.match(home.text,/href="\/autopilot\/reviews\/catalog-health"/);
    const page=await browser.get('/autopilot/reviews/catalog-health').expect(200);
    assert.match(page.text,/of 12 checks passed across 3 active SKUs/);
    const result=await reviews.run(db,ctx,'catalog-health',{filter:'HEALTH-1',scheduled:true});
    assert.equal(result.rows.length,1);assert.equal(result.rows[0]['Checks passed'],'3 of 4');
    assert.match(result.rows[0]['What to fix'],/duplicate/);
    const list=await reviews.run(db,ctx,'catalog-fixes',{filter:'HEALTH-2'});
    if(tier==='starter')assert.deepEqual(Object.keys(list.rows[0]),['Suggestion']);
    else assert.match(list.rows[0]['What to fix'],/duplicate.*cost.*weight/);
    const classify=()=>reviews.run(db,ctx,'product-categories',{filter:'HEALTH-2',scheduled:true});
    if(tier==='starter')await assert.rejects(classify(),e=>e.code==='entitlement_required');
    else{
      const [product]=(await classify()).rows;
      assert.equal(product['Suggested category'],'Packaging');assert.equal(product['Suggested tags'],'Sample, Paper');
      assert.match(product.Evidence,/2 categorized products/);
    }
  }
  await db.query("UPDATE catalogue_item_facts SET category='Supplies' WHERE workspace_id=$1 AND item_id=$2",[ctx.workspaceId,complete.itemId]);
  assert.equal((await reviews.run(db,ctx,'product-categories',{filter:'HEALTH-2'})).rows[0]['Suggested category'],null);
  await db.query("UPDATE skus SET barcode='000032' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,other.skuIds[0]]);
  assert.equal((await reviews.run(db,ctx,'catalog-health',{filter:'HEALTH-1'})).rows.length,0);
  await db.query('UPDATE items SET is_active=0 WHERE workspace_id=$1',[ctx.workspaceId]);
  assert.match((await reviews.run(db,ctx,'catalog-health')).summary,/Add your first product/);
  await assert.rejects(reviews.run(db,{...ctx,actorId:'not-the-owner'},'catalog-health'),/business owner/);
});
