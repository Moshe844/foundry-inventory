'use strict';

process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const reviews=require('../../src/autopilot/job-reviews');

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
