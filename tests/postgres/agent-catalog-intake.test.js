'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('supplier catalogues and variant sheets keep their plan restrictions through the real import worker',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,subscribe}=f;
  await subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  const imports=require('../../src/imports/postgres-service'),assistant=require('../../src/assistant/postgres-service');
  const handler=require('../../src/operations/postgres-runtime-handlers').create()['import.execute-approved'];
  async function plan(text,options={}){
    const proposed=await imports.analyse(db,ctx,{text,filename:'Supplier catalogue.csv',allowModel:false,...options});
    return imports.revise(db,ctx,proposed.id,{expectedHash:proposed.integrityHash,confirmCatalogOnly:true});
  }
  const catalogue=await plan('Product,SKU,Unit cost\nSupplier component,CATALOG-NEW,7.50');
  const args={action:'import.supplier_catalog',recordReference:catalogue.id};
  await subscribe('starter');await assert.rejects(assistant.prepareAction(db,ctx,'Load this supplier file',args),e=>e.code==='entitlement_required');
  for(const tier of ['growth','pro','enterprise']){await subscribe(tier);assert.equal((await assistant.prepareAction(db,ctx,'Load this supplier file',args)).status,'PREPARED');}
  await subscribe('growth');const approval=await assistant.prepareAction(db,ctx,'Load this supplier file',args);
  await assistant.executeProposal(db,ctx,approval.proposal.id);
  const job=(await db.query("SELECT * FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='import.execute-approved' AND payload->>'planId'=$2",[ctx.workspaceId,catalogue.id])).rows[0];
  const input={workspaceId:ctx.workspaceId,payload:job.payload};
  await subscribe('starter');await assert.rejects(handler(input,db),e=>e.code==='entitlement_required');
  await assert.rejects(imports.execute(db,ctx,catalogue.id),e=>e.code==='entitlement_required');
  assert.equal((await db.query("SELECT count(*)::int n FROM skus WHERE workspace_id=$1 AND code='CATALOG-NEW'",[ctx.workspaceId])).rows[0].n,0);
  await subscribe('growth');const imported=await handler(input,db);assert(imported.verified);
  assert.equal((await db.query("SELECT amount_minor::int FROM sku_purchase_costs p JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id WHERE s.workspace_id=$1 AND s.code='CATALOG-NEW'",[ctx.workspaceId])).rows[0].amount_minor,750);
  assert((await handler(input,db)).execution.status==='SUCCEEDED');assert.equal(await f.balance(),4);
  const variants=await plan('Product,SKU,Color,Size\nCotton tee,TEE-RED-S,Red,S\nCotton tee,TEE-BLUE-M,Blue,M',
    {mappings:{name:0,code:1,variant1:2,variant2:3}});
  const request={action:'import.variants',recordReference:variants.id};
  await subscribe('starter');await assert.rejects(assistant.prepareAction(db,ctx,'Build tee variants',request),e=>e.code==='entitlement_required');
  await subscribe('growth');const proposed=await assistant.prepareAction(db,ctx,'Build tee variants',request);await assistant.executeProposal(db,ctx,proposed.proposal.id);
  const variantJob=(await db.query("SELECT payload FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='import.execute-approved' AND payload->>'planId'=$2",[ctx.workspaceId,variants.id])).rows[0];
  assert((await handler({workspaceId:ctx.workspaceId,payload:variantJob.payload},db)).verified);
  const rows=(await db.query("SELECT s.item_id,s.variant_label FROM skus s WHERE s.workspace_id=$1 AND s.code LIKE 'TEE%' ORDER BY s.variant_label",[ctx.workspaceId])).rows;
  assert.equal(rows.length,2);assert.equal(new Set(rows.map(r=>r.item_id)).size,1);assert(rows.some(r=>/Red/.test(r.variant_label)));assert(rows.some(r=>/Blue/.test(r.variant_label)));
  assert.equal(await f.balance(),4);
  const inferred=await plan('Product,SKU,Color,Size\nInferred family,NO-INFER,Red,S\nInferred family,NO-INFER,Blue,M',
    {mappings:{name:0,code:1,variant1:2,variant2:3}});
  await assert.rejects(assistant.prepareAction(db,ctx,'Build the supplied variants',{action:'import.variants',recordReference:inferred.id}),/exact supplied SKUs/);
});
