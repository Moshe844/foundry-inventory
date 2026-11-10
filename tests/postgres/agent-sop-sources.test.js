'use strict';

process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const request=require('supertest');
const sop=require('../../src/documents/agent-sop-sources');
const {pricedUsage}=require('../helpers/postgres-model-fixture');

test('procedure originals prepare exact standing rules with current Pro and Custom authority',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20});
  const {db,ctx}=f;
  const sku=(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code;
  const teamStep='Count damaged cartons before moving them to the inspection bench.';
  let threshold=22;
  let badQuote=false;
  const clause=()=>`Show a Needs You warning when ${sku} has ${threshold} units or fewer on hand at Dispatch.`;
  const provider={name:'anthropic',model:'claude-haiku-4-5-20251001',async complete(input){
    let data;
    if(input.schemaName==='stockchief_sop_source'){
      assert(input.prompt.includes(clause()));assert(input.prompt.includes(teamStep));
      data={complete:true,steps:[{page:1,quote:badQuote?'Changed quotation that is absent from the original.':clause(),label:'Dispatch stock warning',category:'standing_rule'},
        {page:1,quote:teamStep,label:'Damaged carton check',category:'team_step'}]};
    }else if(input.schemaName==='postgres_operating_instruction'){
      assert.equal(JSON.parse(input.prompt).instruction,clause());
      data={understood:true,summary:'Warn about stock in Dispatch',clarifyingQuestion:'',unsupportedReason:'',changes:[{
        domain:'stock_alert',operation:'set',sku,supplier:'',location:'Dispatch',sourceLocation:'',
        reorderPoint:-1,targetStock:-1,safetyStock:-1,leadTimeDays:-1,unitsPerPurchaseUnit:-1,minimumOrderQuantity:-1,orderMultiple:-1,
        maximumQuantity:-1,maximumValue:-1,weeklyValue:-1,daysOfStock:-1,preferTransferBeforePurchasing:false,guardMode:'',guardComparator:'',
        guardThreshold:-1,guardReleaseCondition:'',notificationThreshold:threshold,notificationMetric:'on_hand',
        notificationComparator:'at_or_below',capabilityName:''}]};
    }else if(input.schemaName==='postgres_operating_instruction_effect_fit'){
      const source=JSON.parse(input.prompt);
      assert.equal(source.ownerInstruction,clause());assert(source.enforcedEffects.some(effect=>effect.includes(String(threshold))));
      data={equivalent:true,difference:''};
    }else throw new Error('Unexpected model schema '+input.schemaName);
    return {data,usage:pricedUsage()};
  }};
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID(),aiProvider:provider});
  f.cleanup(()=>app.locals.sessionStore.close());
  const browser=request.agent(app),login=await browser.get('/login');
  await browser.post('/login').type('form').send({_csrf:f.csrf(login.text),email:f.email,password:f.password});
  const root='/autopilot/procedure-originals';
  const source=()=>Buffer.from(`Warehouse procedure\n${clause()}\n${teamStep}\n`);
  for(const tier of ['starter','growth']){
    await f.subscribe(tier);
    const page=await browser.get(root).expect(200);
    assert.match(page.text,/Pro/);assert.doesNotMatch(page.text,/name="procedure"/);
    await assert.rejects(sop.enqueue(db,ctx,{filename:'Procedure.txt',buffer:source()}),error=>error.code==='entitlement_required');
  }
  const settings=async()=>(await db.query('SELECT threshold,armed FROM stockchief_runtime.stock_threshold_rules WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,f.item.skuIds[0],f.location.id])).rows;
  await db.query(`INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason)
    VALUES($1,$2,'ai_work_credits',10000,'Synthetic Custom allowance'),($3,$2,'agent_documents',100,'Synthetic Custom allowance')`,[randomUUID(),f.owner.accountId,randomUUID()]);
  for(const tier of ['pro','enterprise']){
    await f.subscribe(tier);
    const home=await browser.get(root).expect(200);
    const upload=await browser.post(root).field('_csrf',f.csrf(home.text)).attach('procedure',source(),'Procedure.txt').expect(303);
    const href=upload.headers.location,id=href.split('/').at(-1);
    assert.equal((await sop.enqueue(db,ctx,{filename:'Duplicate.txt',buffer:source()})).id,id);
    const handlers=require('../../src/operations/postgres-runtime-handlers').create(undefined,{aiProvider:provider});
    const job=await require('../../src/operations/postgres-job-queue').processOne(db,{[sop.kind]:handlers[sop.kind]},{owner:'sop-fixture-worker'});
    assert.equal(job.status,'COMPLETED',JSON.stringify(job.lastError));
    const page=await browser.get(href).expect(200);
    assert(page.text.includes(teamStep));assert(page.text.includes(clause()));assert.match(page.text,/100 AI credits used/);
    assert.equal((await browser.get(href+'/original').expect(200)).body.toString(),source().toString());
    const record=await sop.load(db,ctx,id);
    const proof={_csrf:f.csrf(page.text),confirmed:'yes',sourceHash:record.source_hash};
    await assert.rejects(sop.prepare(db,ctx,{...proof,sourceId:id,quoteId:record.reading.steps[1].id},{provider}),/checked standing rule/);
    const prepared=await browser.post(href+'/prepare').type('form').send({...proof,quoteId:record.reading.steps[0].id}).expect(303);
    const rule=await browser.get(prepared.headers.location).expect(200);
    assert.match(rule.text,/Original procedure clause/);
    const proposal=await require('../../src/manager/postgres-operating-instructions').get(db,ctx.workspaceId,prepared.headers.location.split('/').at(-1));
    assert.equal(proposal.sopSource.sourceId,id);
    assert.equal((await settings()).some(row=>Number(row.threshold)===threshold),false);
    if(tier==='pro'){
      await f.subscribe('growth');
      const locked=await browser.get(prepared.headers.location).expect(200);
      assert.match(locked.text,/Pro/);assert.doesNotMatch(locked.text,/Approve standing rule/);
      await assert.rejects(require('../../src/manager/postgres-operating-instructions').approve(db,ctx,proposal.id,proposal.integrityHash),error=>error.code==='entitlement_required');
      await f.subscribe(tier);
    }
    await browser.post(prepared.headers.location+'/approve').type('form').send({_csrf:f.csrf(rule.text),integrityHash:proposal.integrityHash}).expect(303);
    const [active]=await settings();
    assert.equal(Number(active.threshold),threshold);assert.equal(active.armed,false);
    const pageContext=await require('../../src/assistant/postgres-page-context').load(db,ctx.workspaceId,href);
    assert.deepEqual(pageContext.procedureReview,{agentJob:'procedure-originals',search:id});
    const prompt=require('../../src/assistant/postgres-agent-context').prompt({originalRequest:'Use this procedure to walk me through receiving.',page:pageContext});
    assert.match(prompt,/read\.agent_review/);assert(prompt.includes(id));
    const read=require('../../src/assistant/postgres-capability-registry').registry.get('read.agent_review');
    const guidance=await read.prepare(null,db,ctx,'Show the exact procedure in order',pageContext.procedureReview);
    assert.deepEqual(guidance.rows.map(row=>[row['Original clause'],row.Use]),[[clause(),'Approved instruction recorded'],[teamStep,'Team procedure']]);
    threshold++;
  }
  const before=(await db.query("SELECT count(*)::int n FROM commercial_usage_events WHERE workspace_id=$1 AND status='COMMITTED'",[ctx.workspaceId])).rows[0].n;
  badQuote=true;
  const failed=await sop.enqueue(db,ctx,{filename:'Unverified.txt',buffer:source()});
  const handlers=require('../../src/operations/postgres-runtime-handlers').create(undefined,{aiProvider:provider});
  const job=await require('../../src/operations/postgres-job-queue').processOne(db,{[sop.kind]:handlers[sop.kind]},{owner:'sop-failure-worker'});
  assert.equal(job.status,'DEAD');
  const original=await sop.load(db,ctx,failed.id);
  assert.equal(original.state,'FAILED');assert.equal(original.credits_used,0);assert(original.content.equals(source()));
  assert.equal((await db.query("SELECT count(*)::int n FROM commercial_usage_events WHERE workspace_id=$1 AND status='COMMITTED'",[ctx.workspaceId])).rows[0].n,before);
  assert.equal(await f.balance(),20);
});
