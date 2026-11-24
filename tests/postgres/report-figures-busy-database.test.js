'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict');
// Measured on AWS 2026-11-24: during a million-row import, Reports failed with a 500 when
// one card's query hit its time limit, and Buy waited up to 13 s for the low-stock count.
test('a busy database slows one figure, never the whole Reports page, and Buy shows the last count with its time',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,catalog=require('../../src/domain/postgres-catalog-service');
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,source) VALUES('busy-figures-plan',$1,'enterprise','COMP','ISOLATED_TEST') ON CONFLICT(account_id) DO NOTHING",[f.owner.accountId]);
 for(let n=0;n<4;n++)await catalog.createItem(db,ctx,{name:'Busy figure '+n,baseCode:'BUSY-FIGURE-'+n,trackingMode:'quantity'});
 await db.query("INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,source,created_at,updated_at) SELECT 'busy-policy-'||s.id,s.workspace_id,s.id,$2,10,20,0,'manual',$3,$3 FROM skus s WHERE s.workspace_id=$1",[ctx.workspaceId,f.location.id,new Date().toISOString()]);
 const business=require('../../src/reports/business-reports'),reports=require('../../src/reports/postgres-service'),lowStock=require('../../src/reports/low-stock-count');
 const busy=()=>Object.assign(Error('canceling statement due to statement timeout'),{code:'57014'});

 await t.test('one card that times out is shown as still counting; the others still answer',async()=>{
  const original=reports.run,stockValue=business.definitions.find(d=>d.key==='stock-value');
  const mock=t.mock.method(reports,'run',async(...args)=>{if(args[3]?.dataset===stockValue.dataset)throw busy();return original(...args);});
  try{
   const page=await business.settledCards(db,ctx,{role:'owner'},{});
   const card=page.cards.find(c=>c.key==='stock-value');assert.equal(card.unavailable,true);assert.equal(card.title,stockValue.title);
   assert(page.cards.some(c=>!c.unavailable&&c.value!==undefined),'the other cards still answer');
   // A bundle with a card still counting is never kept as the last good one.
   mock.mock.restore();await require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId:f.item.skuIds[0],locationId:f.location.id,quantity:1,unitCost:'1.00',idempotencyKey:'busy-figures-1'});
   const healed=await business.settledCards(db,ctx,{role:'owner'},{});assert.equal(healed.cards.find(c=>c.key==='stock-value').unavailable,undefined);assert.equal(healed.current,true);
  }finally{mock.mock.restore();}
 });

 await t.test('any other failure still reaches the page instead of hiding a defect',async()=>{
  const mock=t.mock.method(reports,'run',async()=>{throw Error('a real defect');});
  try{await require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId:f.item.skuIds[0],locationId:f.location.id,quantity:1,unitCost:'1.00',idempotencyKey:'busy-figures-2'});
   await assert.rejects(()=>business.cards(db,ctx,{role:'owner'},{}),/a real defect/);}finally{mock.mock.restore();}
 });

 await t.test('while a fresh low-stock count is slow, Buy gets the last count and when it was counted',async()=>{
  const first=await lowStock.summary(db,ctx.workspaceId);assert.equal(first.current,true);assert(first.items>0);
  const original=lowStock.compute;let release;const slow=new Promise(r=>{release=r;});
  const mock=t.mock.method(lowStock,'compute',async(...args)=>{await slow;return original(...args);});
  try{
   await require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId:f.item.skuIds[0],locationId:f.location.id,quantity:50,unitCost:'1.00',idempotencyKey:'busy-figures-3'});
   const started=Date.now(),during=await lowStock.summary(db,ctx.workspaceId);
   assert(Date.now()-started<5000,'the page does not wait for the slow count');
   assert.equal(during.current,false);assert.equal(during.items,first.items);assert.equal(new Date(during.asOf).getTime(),new Date(first.asOf).getTime());
   release();await new Promise(r=>setTimeout(r,50));
   const after=await lowStock.summary(db,ctx.workspaceId);assert.equal(after.current,true);assert.equal(after.items,first.items-1,'the restocked item is no longer low');
  }finally{release();mock.mock.restore();}
 });
});
