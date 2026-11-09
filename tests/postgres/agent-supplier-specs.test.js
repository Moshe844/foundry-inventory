'use strict';

process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const imports=require('../../src/imports/postgres-service'),assistant=require('../../src/assistant/postgres-service');
const facts=require('../../src/domain/postgres-catalog-facts');

test('recurring import files reuse owner-approved columns at the permitted level without importing any rows',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,subscribe,browser}=f;
  await subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  const modes=require('../../src/autopilot/job-modes');
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const source=(code,options={})=>imports.analyse(db,ctx,{filename:'Warehouse master.csv',
    buffer:Buffer.from('Product,SKU,Vendor A17\nItem '+code+','+code+',Metal finish'),allowModel:false,...options});
  const template=await source('MAP-REF',{mappings:{name:0,code:1,description:2}});
  await imports.approve(db,ctx,template.id,template.integrityHash);assert.ok((await imports.execute(db,ctx,template.id)).verified);
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);const p=await source('MAP-'+tier),path='/imports/'+p.id;
    assert.equal(p.transformations.columnTemplate.source,template.id);assert.equal(p.approvalStatus,'AWAITING_APPROVAL');
    const page=await browser.get(path).expect(200);assert.match(page.text,/Column mapping from an earlier file/);
    if(tier==='starter'){
      assert.equal(p.fieldMappings.description,undefined);assert.match(page.text,/Use the earlier column mapping/);
      await browser.post(path+'/previous-mapping').type('form').send({_csrf:f.csrf(page.text),source:template.id,integrityHash:p.integrityHash}).expect(303);
      const current=await imports.get(db,ctx.workspaceId,p.id);assert.equal(current.fieldMappings.description,2);assert.equal(current.approvalStatus,'AWAITING_APPROVAL');
    }else{assert.equal(p.fieldMappings.description,2);assert.ok(p.transformations.columnTemplate.automatic);}
  }
  await modes.save(db,ctx,133,{mode:'ask',revision:0});assert.equal((await source('ASK-FIRST')).fieldMappings.description,undefined);
  const unrelated=await source('UNRELATED',{filename:'Another vendor.csv'});assert.equal(unrelated.transformations.columnTemplate,undefined);
  assert.equal((await db.query("SELECT count(*)::int n FROM skus WHERE workspace_id=$1 AND code LIKE 'MAP-%'",[ctx.workspaceId])).rows[0].n,1);
});

test('supplier specs fill only evidenced missing fields, govern bulk approval, and survive retries',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,subscribe,browser}=f;
  await subscribe('enterprise');
  await db.query("UPDATE accounts SET created_at=(now()-interval '16 days')::text WHERE id=$1",[f.owner.accountId]);
  const source=await imports.analyse(db,ctx,{text:'Name,SKU,Location,Qty,Width cm\nSmall box,BOX-S,Dispatch,0,20\nLarge box,BOX-L,Dispatch,0,30',allowModel:false});
  await imports.approve(db,ctx,source.id,source.integrityHash);
  assert.ok((await imports.execute(db,ctx,source.id)).verified);
  const {rows}=await db.query("SELECT id,code FROM skus WHERE workspace_id=$1 AND code IN ('BOX-S','BOX-L') ORDER BY code",[ctx.workspaceId]);
  const [large,small]=rows;
  const write=(s,n,name,value)=>db.transaction(c=>facts.saveManyInTransaction(c,ctx,[{skuId:s.id,rowNumber:n,importId:source.id,name,value}]));
  await write(large,2,'UPC','000345');await write(small,3,'UPC','000345');
  await write(large,2,'Weight kg','1.250');await write(small,3,'Weight g','250');
  await write(large,2,'Length mm','600');await write(large,3,'Length cm','70');
  await write(small,3,'Height','98'); // Unit unspecified.
  const prep=(sku)=>assistant.prepareAction(db,ctx,'Fill specifications from this supplier file',{action:'catalog.fill_supplier_specs',sourceImport:source.id,sku});
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    if(tier==='starter'){await assert.rejects(prep(),e=>e.code==='entitlement_required');continue;}
    const page=await browser.get('/autopilot/reviews/supplier-specifications').query({filter:source.id}).expect(200);
    assert.match(page.text,/Barcode identifies another SKU/);assert.match(page.text,/conflicting source values/);
    assert.match((await prep()).proposal.summary,/Fill .* missing product fields/);
  }
  const proposal=await prep(),page=await browser.get('/actions/'+proposal.proposal.id).expect(200);
  assert.match(page.text,/Weight \(g\)/);assert.match(page.text,/1250/);
  await subscribe('starter');await assert.rejects(assistant.executeProposal(db,ctx,proposal.proposal.id),e=>e.code==='entitlement_required');
  await subscribe('growth');await write(small,3,'Weight g','260');
  await assert.rejects(assistant.executeProposal(db,ctx,proposal.proposal.id),/changed/);
  const approved=await prep();await assistant.executeProposal(db,ctx,approved.proposal.id);await assistant.executeProposal(db,ctx,approved.proposal.id);
  const actual=(await db.query('SELECT code,barcode,width_mm,weight_grams,length_mm,height_mm FROM skus WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY code',[ctx.workspaceId,[small.id,large.id]])).rows;
  assert.deepEqual(actual.map(r=>[r.code,Number(r.width_mm),Number(r.weight_grams),r.barcode,r.length_mm,r.height_mm]),[['BOX-L',300,1250,null,null,null],['BOX-S',200,260,null,null,null]]);
  await assert.rejects(prep(),/No missing/);
  assert.equal((await db.query("SELECT count(*)::int n FROM catalogue_change_history WHERE workspace_id=$1 AND action='fill_supplier_spec'",[ctx.workspaceId])).rows[0].n,4);
  await write(large,2,'Height (cm)','40');
  const mission=await prep(large.code);
  const plans=require('../../src/assistant/postgres-capability-plans'),{registry}=require('../../src/assistant/postgres-capability-registry');
  await plans.save(db,ctx,'Fill product specs and check data health',randomUUID(),[{contract:registry.get('catalog.fill_supplier_specs'),args:{},dependsOn:[]},
    {contract:registry.get('read.agent_review'),args:{agentJob:'catalog-health'},dependsOn:[0]}],[{result:mission},{result:{status:'CLARIFY'}}]);
  await assert.rejects(assistant.executeMission(db,ctx,mission.proposal.id),e=>e.code==='entitlement_required');
  await subscribe('pro');await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await assistant.executeMission(db,ctx,mission.proposal.id);
  assert.equal(Number((await db.query('SELECT height_mm FROM skus WHERE id=$1 AND workspace_id=$2',[large.id,ctx.workspaceId])).rows[0].height_mm),400);
});
